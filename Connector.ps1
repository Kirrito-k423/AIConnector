#requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateSet('Submit','Poll','Audit','Watch','Serve','Flush','Status','Claim','Complete','Upload','UploadDiagnostics','RetryRejected','Advertise','Capabilities')][string]$Action='Status',
    [ValidateSet('mac-outer','windows-inner')][string]$Node='windows-inner',
    [string]$Config='', [string]$StateDir='', [string]$File='', [string]$Key='',
    [string]$Proxy='system', [switch]$PromptToken,
    [ValidatePattern('^[a-zA-Z0-9_-]{0,96}$')][string]$OperationId='',
    [ValidatePattern('^(|[a-f0-9]{48})$')][string]$ClaimOwner='',
    [ValidateRange(1,120)][int]$TimeoutSeconds=30,
    [ValidateRange(0,3600)][int]$PollSeconds=0,
    [ValidateRange(0,100000)][int]$Cycles=0
)
$ErrorActionPreference='Stop'
$script:Utf8=New-Object Text.UTF8Encoding($false)
# JSON is consumed by Node/Python as UTF-8, including on Windows PowerShell 5.1.
[Console]::OutputEncoding=$script:Utf8
[Console]::InputEncoding=$script:Utf8
$OutputEncoding=$script:Utf8
Add-Type -AssemblyName System.Net.Http
$root=[IO.Path]::GetDirectoryName($PSCommandPath)
if (-not $Config) { $Config=Join-Path $root 'connector.config.json' }
$defaultStateDir=-not $StateDir
if (-not $StateDir) { $StateDir=Join-Path (Join-Path $root 'connector-state') $Node }
$StateDir=[IO.Path]::GetFullPath($StateDir)
$script:Token=''; $script:State=$null; $script:Lock=$null; $script:WatchLock=$null
$script:IoScope='action:'+$Action+':'+$Key
$script:HttpClient=$null
$script:SavedStateHash=''; $script:ProjectionHashes=@{}; $script:ProjectionWrites=0
$script:DeferUploadVerification=$false
$script:Resident=$false; $script:SnapshotCache=$null; $script:SnapshotStateHash=''
$script:MetadataCache=@{}; $script:MetadataCredential=''
$script:Profiler=$null; $script:CanonicalDepth=0
if (-not $OperationId) { $OperationId=[Guid]::NewGuid().ToString('N') }
function Trace-Event([string]$Kind,[hashtable]$Values=@{}) {
    # No request headers, query strings, bodies, credentials, or free-form errors.
    try {
        $row=@{schema='aiconnector.timing.v1';at=[DateTimeOffset]::UtcNow.ToString('o');source='connector';operation_id=$OperationId;action=$Action;kind=$Kind}
        if ($script:IoScope -cmatch '^[a-zA-Z0-9_:/-]{1,240}$') { $row.scope=$script:IoScope }
        if ($Key -cmatch '^[a-z0-9_-]+/[1-9][0-9]*/[a-z0-9_-]+$') { $row.key=$Key }
        foreach ($name in @('key','event_id','event_kind','method','endpoint','request_id','http','category','elapsed_ms','bytes','retry_at','confirmed_at','files_written','events_sent','entries_removed','stage','cpu_ms','exception_type','native_code','line')) {
            if ($Values.ContainsKey($name)) { $row[$name]=$Values[$name] }
        }
        $trace=Join-Path $StateDir 'transport-timing.jsonl'
        if ([IO.File]::Exists($trace) -and ([IO.FileInfo]::new($trace)).Length -ge 2097152) {
            if ([IO.File]::Exists($trace+'.1')) { [IO.File]::Delete($trace+'.1') }
            [IO.File]::Move($trace,$trace+'.1')
        }
        [IO.File]::AppendAllText($trace,(ConvertTo-Json -InputObject $row -Depth 50 -Compress)+"`n",$script:Utf8)
    } catch { } # Timing failure must never change a delivery or execution decision.
}
function Start-Profiling {
    try {
        if (-not ('AIConnector.RuntimeProfiler' -as [type])) { Add-Type -TypeDefinition ([IO.File]::ReadAllText((Join-Path $root 'service/runtime-profiler.cs'))) }
        $script:Profiler=New-Object AIConnector.RuntimeProfiler((Join-Path $StateDir 'runtime-windows.jsonl'))
        Trace-Event 'profiler_ready' @{category=('powershell_'+$PSVersionTable.PSVersion.ToString().Replace('.','_'))}
    } catch { Trace-Event 'profiler_unavailable' @{category=(Error-Code $_)} }
}
function Start-Stage([string]$Name) {
    if ($null -eq $script:Profiler) { return $null }
    try { $script:Profiler.Push($Name); return $true } catch { return $null }
}
function Stop-Stage($Stage) {
    if ($null -eq $Stage) { return }
    try { $script:Profiler.Pop() } catch { }
}
function Trace-Fault($Record,[string]$Stage) {
    try {
        $exception=$Record.Exception
        while ($exception.InnerException) { $exception=$exception.InnerException }
        Trace-Event 'stage_failed' @{stage=$Stage;category=(Error-Code $Record);exception_type=$exception.GetType().FullName;native_code=($exception.HResult -band 65535);line=$Record.InvocationInfo.ScriptLineNumber}
    } catch { }
}
function Endpoint-Name([string]$Url) {
    $path=([Uri]$Url).AbsolutePath
    if ($path -match '/issues/comments/[0-9]+$') { return 'comment' }
    if ($path -match '/issues/comments$') { return 'comment_feed' }
    if ($path -match '/issues/[0-9]+/comments$') { return 'task_comments' }
    if ($path -match '/issues$') { return 'routes' }
    if ($path -match '/contents/') { return 'relay_manifest' }
    if ($path -match '/assets$') { return 'release_assets' }
    if ($path -match '/releases/tags/') { return 'release' }
    return 'artifact_or_provision'
}
function Fail([string]$Code) { $e=New-Object InvalidOperationException('Connector stopped'); $e.Data['connector_code']=$Code; throw $e }
function Need($Condition,[string]$Code) { if (-not $Condition) { Fail $Code } }
function Error-Code($Record) {
    $explicit=[string]$Record.Exception.Data['connector_code']
    if ($explicit) { return $explicit }
    # Inspect locally, export only an allowlisted category. Messages may contain credentials.
    $e=$Record.Exception
    while ($null -ne $e) {
        if ($e -is [Threading.Tasks.TaskCanceledException] -or $e -is [TimeoutException]) { return 'HTTP_TIMEOUT' }
        if ($e -is [Security.Authentication.AuthenticationException]) { return 'TLS_ERROR' }
        if ($e -is [Net.Sockets.SocketException]) {
            switch ($e.SocketErrorCode.ToString()) {
                'ConnectionRefused' { return 'CONNECTION_REFUSED' }
                'ConnectionReset' { return 'CONNECTION_RESET' }
                'TimedOut' { return 'HTTP_TIMEOUT' }
                'HostNotFound' { return 'DNS_ERROR' }
                'TryAgain' { return 'DNS_ERROR' }
            }
        }
        if ($e -is [UnauthorizedAccessException]) { return 'FILESYSTEM_ACCESS_DENIED' }
        if ($e -is [IO.IOException]) { return 'FILESYSTEM_IO_ERROR' }
        $e=$e.InnerException
    }
    return 'CONNECTOR_ERROR'
}
function Get-Field($O,[string]$K,$Default=$null) {
    if ($null -eq $O) { return $Default }
    if ($O -is [Collections.IDictionary]) { if ($O.Contains($K)) { return ,$O[$K] }; return $Default }
    if ($null -ne $O.PSObject.Properties[$K]) { return ,$O.$K }; return $Default
}
function As-Map($O) {
    if ($null -eq $O) { return $null }
    if ($O -is [Collections.IDictionary] -or $O -is [pscustomobject]) {
        $m=@{}; $keys=@(); if ($O -is [Collections.IDictionary]) { $keys=@($O.get_Keys()) } else { $keys=@($O.PSObject.Properties | ForEach-Object { $_.Name }) }
        foreach ($k in $keys) { $m[$k]=As-Map (Get-Field $O $k) }; return $m
    }
    if ($O -is [Array]) { $a=@(); foreach ($v in $O) { $a+=,(As-Map $v) }; return ,$a }
    return $O
}
function Json($O) {
    if ($script:CanonicalDepth -gt 0) { return Json-Work $O }
    $stage=Start-Stage 'json.serialize'
    try { Json-Work $O } catch { Trace-Fault $_ 'json.serialize'; throw } finally { Stop-Stage $stage }
}
function Json-Work($O) { return ConvertTo-Json -InputObject $O -Depth 50 -Compress }
function Canonical($O) {
    $stage=Start-Stage 'canonical'
    try {
    $script:CanonicalDepth++; try { Canonical-Work $O } finally { $script:CanonicalDepth-- }
     } catch { Trace-Fault $_ 'canonical'; throw } finally { Stop-Stage $stage }
}
function Canonical-Work($O) {
    if ($null -eq $O) { return 'null' }
    if ($O -is [Collections.IDictionary] -or $O -is [pscustomobject]) {
        [string[]]$keys=@(); if ($O -is [Collections.IDictionary]) { $keys=@($O.get_Keys()) } else { $keys=@($O.PSObject.Properties | ForEach-Object { $_.Name }) }
        [Array]::Sort($keys,[StringComparer]::Ordinal); $parts=@()
        foreach ($k in $keys) { $parts+=((Json-Work $k)+':'+(Canonical-Work (Get-Field $O $k))) }
        return '{'+($parts -join ',')+'}'
    }
    if ($O -is [Array]) { $parts=@(); foreach ($v in $O) { $parts+=,(Canonical-Work $v) }; return '['+($parts -join ',')+']' }
    return Json-Work $O
}
function Get-Sha256([byte[]]$Bytes) { $h=[Security.Cryptography.SHA256]::Create(); try { return ([BitConverter]::ToString($h.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant() } finally { $h.Dispose() } }
function Hash([string]$Text) { return Get-Sha256 ($script:Utf8.GetBytes($Text)) }
function Json-TokenValue($Token) {
    if ($null -eq $Token) { return $null }
    if ($Token -isnot [Newtonsoft.Json.Linq.JToken]) { return $Token }
    if ($Token.get_Type().ToString() -eq 'Object') {
        $map=@{}; foreach ($p in $Token.Properties()) { $map[$p.Name]=Json-TokenValue $p.Value }; return $map
    }
    if ($Token.get_Type().ToString() -eq 'Array') {
        $items=@(); foreach ($item in $Token) { $items+=,(Json-TokenValue $item) }; return ,$items
    }
    return $Token.get_Value()
}
function Parse-WithoutDates([string]$Text) {
    # PS 6/7 before DateKind: use its bundled JSON parser, without date coercion.
    $settings=New-Object Newtonsoft.Json.JsonSerializerSettings
    $settings.DateParseHandling=[Newtonsoft.Json.DateParseHandling]::None
    return Json-TokenValue ([Newtonsoft.Json.JsonConvert]::DeserializeObject($Text,$settings))
}
function Parse([string]$Text) {
    $stage=Start-Stage 'json.parse'
    try { Parse-Work $Text } catch { Trace-Fault $_ 'json.parse'; throw } finally { Stop-Stage $stage }
}
function Parse-Work([string]$Text) {
    if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) {
        return As-Map (ConvertFrom-Json -InputObject $Text -DateKind String)
    }
    if ($PSVersionTable.PSVersion.Major -ge 6) { return Parse-WithoutDates $Text }
    # Windows PowerShell 5.1 already preserves JSON timestamp strings.
    return As-Map (ConvertFrom-Json -InputObject $Text)
}
function Read-Json([string]$Path) { Need ([IO.FileInfo]::new($Path).Length -le 16777216) 'FILE_TOO_LARGE'; return Parse ([IO.File]::ReadAllText($Path,$script:Utf8)) }
function Epoch { return [long]([DateTimeOffset]::UtcNow.ToUnixTimeSeconds()) }
function Source-Time($Value) {
    if ($null -eq $Value -or [string]$Value -eq '') { return '' }
    # Normalize only explicit source-event times, never values inside protocol payloads.
    if ($Value -is [DateTime] -or $Value -is [DateTimeOffset]) { $date=[DateTimeOffset]$Value }
    else {
        $date=[DateTimeOffset]::MinValue
        Need ([DateTimeOffset]::TryParse([string]$Value,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::AssumeUniversal,[ref]$date)) 'INVALID_SOURCE_TIME'
    }
    return $date.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'",[Globalization.CultureInfo]::InvariantCulture)
}
function Atomic([string]$Path,[string]$Text) {
    $label='projection.write'; if ([IO.Path]::GetFileName($Path) -ceq 'state.json') { $label='state.write' }
    $stage=Start-Stage $label
    try { Atomic-Work $Path $Text } catch { Trace-Fault $_ $label; throw } finally { Stop-Stage $stage }
}
function Atomic-Work([string]$Path,[string]$Text) {
    $tmp=$Path+'.'+[Guid]::NewGuid().ToString('N')+'.tmp'; $data=$script:Utf8.GetBytes($Text)
    try {
        $stream=[IO.File]::Open($tmp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try { $stream.Write($data,0,$data.Length); $stream.Flush($true) } finally { $stream.Dispose() }
        if ([IO.File]::Exists($Path)) { [IO.File]::Replace($tmp,$Path,[NullString]::Value) } else { [IO.File]::Move($tmp,$Path) }
    } finally { if ([IO.File]::Exists($tmp)) { [IO.File]::Delete($tmp) } }
}
function Save {
    $stage=Start-Stage 'state.save'
    try { Save-Work  } catch { Trace-Fault $_ 'state.save'; throw } finally { Stop-Stage $stage }
}
function Save-Work {
    # The local store hashes its exact bytes, not a protocol canonical form.
    # Serialize the whole ledger once; event identities still use Canonical.
    $body=Json $script:State
    $hashStage=Start-Stage 'state.hash'
    try { $digest=Hash $body } finally { Stop-Stage $hashStage }
    if ($digest -ceq $script:SavedStateHash) { return }
    $watch=[Diagnostics.Stopwatch]::StartNew()
    $serialized=Json @{schema='aiconnector.store.v1';sha256=$digest;data_base64=[Convert]::ToBase64String($script:Utf8.GetBytes($body))}
    Need ($script:Utf8.GetByteCount($serialized) -le 16777216) 'STATE_CAPACITY_REACHED'
    Atomic (Join-Path $StateDir 'state.json') $serialized
    $script:SavedStateHash=$digest
    Trace-Event 'state_saved' @{elapsed_ms=[long]$watch.Elapsed.TotalMilliseconds;bytes=$script:Utf8.GetByteCount($serialized)}
}
function Open-State {
    $stage=Start-Stage 'state.open'
    try { Open-State-Work } catch { Trace-Fault $_ 'state.open'; throw } finally { Stop-Stage $stage }
}
function Open-State-Work {
    [IO.Directory]::CreateDirectory($StateDir)|Out-Null
    try { $script:Lock=[IO.File]::Open((Join-Path $StateDir 'state.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None) } catch { Fail 'STATE_BUSY' }
    $script:State=$null
    $path=Join-Path $StateDir 'state.json'
    if ([IO.File]::Exists($path)) {
        try {
            $saved=Read-Json $path; $body=$script:Utf8.GetString([Convert]::FromBase64String($saved.data_base64))
            Need ($saved.schema -ceq 'aiconnector.store.v1' -and (Hash $body) -ceq $saved.sha256) 'STATE_CORRUPT'
            $candidate=Parse $body
            Need ($candidate.binding -ceq $script:Binding) 'STATE_CONFIG_MISMATCH'
            $script:State=$candidate
            $script:SavedStateHash=$saved.sha256
        } catch { if ($_.Exception.Data['connector_code']) { throw }; Fail 'STATE_CORRUPT' }
    } else {
        $script:State=@{binding=$script:Binding;events=@{};comments=@{};outbox=@{};claims=@{};uploads=@{};conflicts=@{};ignored=@{};artifact_errors=@{};next_poll=0L;failures=0;last_error='';last_poll=0L}
        Save
    }
    foreach ($field in @('routes','provisions','scopes','sync')) { if (-not $script:State.ContainsKey($field)) { $script:State[$field]=@{} } }
    if ((Compact-ConfirmedOutbox) -gt 0) { Save }
}
function In-Scope([string]$Scope,[scriptblock]$Work) {
    $previous=$script:IoScope; $script:IoScope=$Scope
    try {
        $row=Get-Field $script:State.scopes $Scope
        if ($row -and $row.next_attempt -gt (Epoch)) { Trace-Event 'cooldown' @{retry_at=$row.next_attempt}; Fail 'REQUEST_COOLDOWN' }
        $value=& $Work
        $script:State.scopes.Remove($Scope); Save
        return ,$value
    } catch {
        $row=Get-Field $script:State.scopes $Scope
        if ($row) { $_.Exception.Data['retry_at']=$row.next_attempt }
        throw
    } finally { $script:IoScope=$previous }
}
function Close-State { if ($null -ne $script:Lock) { $script:Lock.Dispose(); $script:Lock=$null } }
function Assert-Url([string]$Url) {
    $u=[Uri]$Url
    Need ($u.IsAbsoluteUri -and $u.Scheme -in @('http','https') -and -not $u.UserInfo) 'INVALID_URL'
    Need ($u.Scheme -eq 'https' -or $u.IsLoopback) 'HTTPS_REQUIRED'
    return $u
}
function Get-SafeUrl([string]$Url) { try { return ([Uri]$Url).GetLeftPart([UriPartial]::Path) } catch { return '(invalid)' } }
function Invoke-WireHttp {
    param([string]$Url, [string]$Method = 'GET', [hashtable]$Headers = @{},
        [string]$Body = '', [int]$Limit = 2097152, [bool]$Authenticated = $false,
        [byte[]]$BinaryBody = $null, [string]$MultipartFileName = '', [string]$BinaryContentType = 'application/octet-stream')
    $stage=Start-Stage 'http'
    try { Invoke-WireHttp-Work -Url $Url -Method $Method -Headers $Headers -Body $Body -Limit $Limit -Authenticated $Authenticated -BinaryBody $BinaryBody -MultipartFileName $MultipartFileName -BinaryContentType $BinaryContentType } catch { Trace-Fault $_ 'http'; throw } finally { Stop-Stage $stage }
}
function Invoke-WireHttp-Work {
    param([string]$Url, [string]$Method = 'GET', [hashtable]$Headers = @{},
        [string]$Body = '', [int]$Limit = 2097152, [bool]$Authenticated = $false,
        [byte[]]$BinaryBody = $null, [string]$MultipartFileName = '', [string]$BinaryContentType = 'application/octet-stream')
    $u = Assert-Url $Url
    if ($Authenticated -and $u.Scheme -ne 'https' -and -not $u.IsLoopback) {
        Fail '带凭据的请求必须使用 HTTPS。'
    }
    if ($null -eq $script:HttpClient) {
    $handler = New-Object System.Net.Http.HttpClientHandler
    $handler.AllowAutoRedirect = $false
    $handler.UseDefaultCredentials = $false
    $handler.UseCookies = $false
    $handler.AutomaticDecompression = [Net.DecompressionMethods]::GZip -bor [Net.DecompressionMethods]::Deflate
    if ($Proxy -eq 'direct') { $handler.UseProxy = $false }
    elseif ($Proxy -ne 'system') {
        $null = Assert-Url $Proxy
        $handler.Proxy = New-Object System.Net.WebProxy($Proxy)
        $handler.UseProxy = $true
    }
    $script:HttpClient = New-Object System.Net.Http.HttpClient($handler)
    $script:HttpClient.Timeout = [TimeSpan]::FromSeconds($TimeoutSeconds)
    }
    $client=$script:HttpClient
    $cts = New-Object Threading.CancellationTokenSource
    $cts.CancelAfter($TimeoutSeconds * 1000)
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $requestId=[Guid]::NewGuid().ToString('N'); $endpoint=Endpoint-Name $Url
    Trace-Event 'http_started' @{request_id=$requestId;method=$Method;endpoint=$endpoint}
    $result = [ordered]@{ status = 'NETWORK_ERROR'; http = 0; elapsed_ms = 0; bytes = 0; url = (Get-SafeUrl $Url); content_type = ''; sha256 = ''; retry_after = ''; json = $null; data = $null; rate_remaining = ''; rate_reset = '' }
    $response = $null
    $req = $null
    try {
        for ($hop = 0; $hop -le 5; $hop++) {
            $req = New-Object System.Net.Http.HttpRequestMessage(([System.Net.Http.HttpMethod]::new($Method)), $u)
            $req.Headers.TryAddWithoutValidation('User-Agent', 'AIConnector/0.3') | Out-Null
            foreach ($key in $Headers.Keys) { $req.Headers.TryAddWithoutValidation($key, [string]$Headers[$key]) | Out-Null }
            if ($Method -eq 'POST') {
                if ($null -ne $BinaryBody) {
                    $part = New-Object System.Net.Http.ByteArrayContent -ArgumentList (, $BinaryBody)
                    $part.Headers.ContentType = [Net.Http.Headers.MediaTypeHeaderValue]::Parse($BinaryContentType)
                    if ($MultipartFileName) {
                        $multi = New-Object Net.Http.MultipartFormDataContent
                        $multi.Add($part,'file',$MultipartFileName); $req.Content = $multi
                    } else { $req.Content = $part }
                } else { $req.Content = New-Object System.Net.Http.StringContent($Body, $script:Utf8, 'application/json') }
            }
            $response = $client.SendAsync($req, [Net.Http.HttpCompletionOption]::ResponseHeadersRead, $cts.Token).GetAwaiter().GetResult()
            $result.http = [int]$response.StatusCode
            if ($response.Headers.Contains('X-RateLimit-Remaining')) { $result.rate_remaining = [string](@($response.Headers.GetValues('X-RateLimit-Remaining'))[0]) }
            if ($response.Headers.Contains('X-RateLimit-Reset')) { $result.rate_reset = [string](@($response.Headers.GetValues('X-RateLimit-Reset'))[0]) }
            $result.url = Get-SafeUrl $u.AbsoluteUri
            if ($result.http -ge 300 -and $result.http -lt 400) {
                $location = $response.Headers.Location
                $result.status = 'REDIRECT_BLOCKED'
                # Never forward a token across a redirect or rewrite a POST as a GET.
                if ($Authenticated -or $Method -ne 'GET' -or $null -eq $location -or $hop -eq 5) { $result.elapsed_ms = $sw.ElapsedMilliseconds; return [pscustomobject]$result }
                $next = New-Object Uri($u, $location)
                $null = Assert-Url $next.AbsoluteUri
                if ($u.Scheme -eq 'https' -and $next.Scheme -ne 'https') { $result.elapsed_ms = $sw.ElapsedMilliseconds; return [pscustomobject]$result }
                $u = $next
                $response.Dispose(); $response = $null
                $req.Dispose(); $req = $null
                continue
            }
            break
        }
        $result.content_type = [string]$response.Content.Headers.ContentType
        if ($response.Headers.RetryAfter) { $result.retry_after = [string]$response.Headers.RetryAfter }
        $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $buffer = New-Object byte[] 8192
        $mem = New-Object IO.MemoryStream
        try {
            while ($true) {
                $count = $stream.ReadAsync($buffer, 0, [Math]::Min($buffer.Length, $Limit + 1 - [int]$mem.Length), $cts.Token).GetAwaiter().GetResult()
                if ($count -eq 0) { break }
                $mem.Write($buffer, 0, $count)
                if ($mem.Length -gt $Limit) { $result.status = 'BODY_LIMIT_EXCEEDED'; $result.elapsed_ms = $sw.ElapsedMilliseconds; return [pscustomobject]$result }
            }
            $bytes = $mem.ToArray()
        } finally { $mem.Dispose(); $stream.Dispose() }
        $result.data = $bytes
        $result.bytes = $bytes.Length
        $result.sha256 = Get-Sha256 $bytes
        $text = $script:Utf8.GetString($bytes)
        try {
            # A property preserves [] / [item] on both Windows PowerShell 5.1
            # and PowerShell 7, whose root-array pipeline enumeration differs.
            $result.json = (ConvertFrom-Json -InputObject ('{"value":' + $text + '}') -ErrorAction Stop).value
        } catch { }
        if ($result.http -eq 429) { $result.status = 'RATE_LIMITED' }
        elseif ($result.http -eq 401) { $result.status = 'AUTH_REQUIRED_OR_REJECTED' }
        elseif ($result.http -eq 403) { $result.status = 'FORBIDDEN_OR_RATE_LIMITED' }
        elseif ($result.http -eq 404) { $result.status = 'NOT_FOUND_OR_NOT_VISIBLE' }
        elseif ($result.http -ge 200 -and $result.http -lt 300) { $result.status = 'HTTP_OK' }
        else { $result.status = 'HTTP_ERROR' }
    } catch {
        # Exception strings and response bodies can echo tokens: never put them in reports.
        $msg = $_.Exception.ToString()
        if ($cts.IsCancellationRequested -or $msg -match 'timed out|timeout|canceled|cancelled') { $result.status = 'TIMEOUT' }
        elseif ($msg -match 'certificate|SSL|TLS|AuthenticationException') { $result.status = 'TLS_ERROR' }
        elseif ($msg -match 'NameResolution|No such host|nodename|Name or service') { $result.status = 'DNS_ERROR' }
        else { $category=Error-Code $_; if ($category -in @('CONNECTION_REFUSED','CONNECTION_RESET','DNS_ERROR','TLS_ERROR','HTTP_TIMEOUT')) { $result.status=$category } else { $result.status = 'NETWORK_ERROR' } }
    } finally {
        $sw.Stop(); $result.elapsed_ms = $sw.ElapsedMilliseconds
        if ($result.status -cne 'HTTP_OK') { $script:MetadataCache.Clear() }
        $script:WireDiagnostic=@{category=$result.status;http=$result.http}
        if ($null -ne $response) { $response.Dispose() }
        if ($null -ne $req) { $req.Dispose() }
        $cts.Dispose()
        Trace-Event 'http_finished' @{request_id=$requestId;method=$Method;endpoint=$endpoint;http=$result.http;category=$result.status;elapsed_ms=$result.elapsed_ms;bytes=$result.bytes}
    }
    return [pscustomobject]$result
}
function Api([string]$Path,[string]$Method='GET',[string]$Body='') {
    $url=$script:C.api_base.TrimEnd('/')+$Path; $headers=@{Accept='application/json'}
    if ($script:C.provider -eq 'github') {
        $headers.Accept='application/vnd.github+json'; $headers['X-GitHub-Api-Version']='2022-11-28'
        if ($script:Token) { $headers.Authorization='Bearer '+$script:Token }
    } elseif ($script:Token) {
        $join='?'; if ($url.Contains('?')) { $join='&' }
        $url+=$join+'access_token='+[Uri]::EscapeDataString($script:Token)
    }
    return Invoke-WireHttp -Url $url -Method $Method -Body $Body -Headers $headers -Authenticated ([bool]$script:Token) -Limit 8388608
}
function Limited($R) { return ($R.http -eq 429 -or ($R.http -eq 403 -and ($R.retry_after -or $R.rate_remaining -ceq '0'))) }
function Cooldown($R) {
    $now=(Epoch)+1; $n=0L; $date=[DateTimeOffset]::MinValue
    if ([long]::TryParse([string]$R.retry_after,[ref]$n) -and $n -ge 0 -and $n -le 31536000) { return $now+[Math]::Max(1,$n) }
    if ([DateTimeOffset]::TryParse([string]$R.retry_after,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::AssumeUniversal,[ref]$date) -and $date.ToUnixTimeSeconds() -gt $now) { return $date.ToUnixTimeSeconds() }
    if ($R.rate_remaining -ceq '0' -and [long]::TryParse([string]$R.rate_reset,[ref]$n) -and $n -gt $now) { return $n+1 }
    return $now+60*[Math]::Pow(2,[Math]::Min(4,[int]$script:State.failures))
}
function Require-Response($R) {
    if ($R.status -ceq 'HTTP_OK') { return }
    $script:MetadataCache.Clear()
    if (-not $script:Relay -or (Limited $R)) { $script:State.failures++ }
    $script:State.last_error=$R.status+'_'+$R.http
    if (Limited $R) { $script:State.next_poll=Cooldown $R }
    elseif (-not $script:Relay) { $script:State.next_poll=(Epoch)+[Math]::Min(900,30*[Math]::Pow(2,[Math]::Min(5,$script:State.failures))) }
    else {
        $old=Get-Field $script:State.scopes $script:IoScope
        $count=1+[int](Get-Field $old 'failures' 0)
        $script:State.scopes[$script:IoScope]=@{failures=$count;error=$script:State.last_error;failed_at=(Epoch);next_attempt=((Epoch)+[Math]::Min(300,5*[Math]::Pow(2,[Math]::Min(6,$count-1))))}
        # A provider rate limit is global. A single route/asset 5xx is not.
        # Repeated transport failures across independent operations indicate an outage.
        $transport=@($script:State.scopes.Values | Where-Object { $_.failed_at -ge (Epoch)-60 -and $_.error -match '^(TLS_ERROR|DNS_ERROR|TIMEOUT|NETWORK_ERROR|CONNECTION_)' })
        if ($transport.Count -ge 3 -or $R.http -eq 401) { $script:State.next_poll=(Epoch)+60 }
    }
    $retry=Get-Field (Get-Field $script:State.scopes $script:IoScope) 'next_attempt' $script:State.next_poll
    Trace-Event 'retry_scheduled' @{category=$R.status;http=$R.http;retry_at=$retry}
    Save; Fail $script:State.last_error
}
function Read-List([string]$Path,[string]$Query='') {
    $all=@()
    for ($page=1;$page -le $script:C.max_pages;$page++) {
        $r=Api ($Path+'?per_page=100&page='+$page+$Query); Require-Response $r
        Need ($r.json -is [Array]) 'INVALID_COMMENT_LIST'
        $all+=@($r.json)
        if ($r.json.Count -lt 100) { return ,$all }
    }
    Fail 'PAGINATION_INCOMPLETE'
}
function Read-Comments {
    if (-not $script:Relay) { return ,(Read-List $script:CommentsPath) }
    Assert-Relay
    $routes=Read-Routes; $all=@()
    foreach ($route in $routes.Values) {
        foreach ($comment in (Read-List ($script:RepoPath+'/issues/'+$route.number+'/comments'))) {
            $row=As-Map $comment; $row.relay_task_id=$route.task_id; $row.relay_issue=$route.number; $all+=,$row
        }
    }
    # Do not import any event unless every required page has been read.
    return ,$all
}
function Is-Integer($V) { return ($V -is [int] -or $V -is [long]) }
function Valid-Id($V) { return ($V -is [string] -and $V -cmatch '^[a-z0-9][a-z0-9_-]{0,63}$') }
function Run-Key($E) { return $E.task_id+'/'+$E.revision+'/'+$E.run_id }
function Payload($E) { return Parse ($script:Utf8.GetString([Convert]::FromBase64String($E.payload_b64))) }
function Artifact-Valid($A) {
    Need ($A -is [Collections.IDictionary]) 'INVALID_ARTIFACT'
    Need ($A.name -is [string] -and $A.name -cmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}\.zip$') 'INVALID_ARTIFACT_NAME'
    Need ((Is-Integer $A.bytes) -and $A.bytes -gt 0 -and $A.bytes -lt 5242880) 'INVALID_ARTIFACT_SIZE'
    Need ($A.sha256 -is [string] -and $A.sha256 -cmatch '^[a-f0-9]{64}$') 'INVALID_ARTIFACT_HASH'
    $u=Assert-Url $A.url; Need (-not $u.Query -and -not $u.Fragment) 'INVALID_ARTIFACT_URL'
    $allowed=$false
    foreach ($prefix in $script:C.artifact_prefixes) { if ($u.AbsoluteUri.StartsWith($prefix,[StringComparison]::Ordinal)) { $allowed=$true } }
    Need $allowed 'ARTIFACT_HOST_NOT_ALLOWED'
}
function Validate-Data($E,$D) {
    Need ($D -is [Collections.IDictionary]) 'INVALID_PAYLOAD'
    if ($E.kind -in @('task','result')) {
        Need ($D.artifacts -is [Array] -and $D.artifacts.Count -le 5) 'INVALID_ARTIFACT_LIST'
        $names=@{}; foreach ($a in $D.artifacts) {
            Artifact-Valid $a; Need (-not $names.ContainsKey($a.name)) 'DUPLICATE_ARTIFACT_NAME'; $names[$a.name]=$true
            if ($script:Relay) {
                $role='input'; if ($E.kind -eq 'result') { $role='result' }
                $expected=$script:C.artifact_prefixes[0]+(Run-Tag $E)+'/'+$role+'--'+$E.sender+'--'+$a.sha256+'.zip'
                Need ($a.url -ceq $expected) 'ARTIFACT_RUN_MISMATCH'
            }
        }
    }
    if ($E.kind -eq 'task') {
        foreach ($field in @('title','objective')) { Need ($D[$field] -is [string] -and $D[$field].Length -gt 0 -and $D[$field].Length -le 4096) 'INVALID_TASK_TEXT' }
        foreach ($pair in @(@('code','repository'),@('code','revision'),@('environment','target'),@('invocation','entry'))) {
            $v=Get-Field (Get-Field $D $pair[0]) $pair[1]
            Need ($v -is [string] -and $v.Length -gt 0 -and $v.Length -le 1024) 'MISSING_TASK_FIELD'
        }
        Need ($D.invocation.arguments -is [Array] -and @($D.invocation.arguments | Where-Object { $_ -isnot [string] }).Count -eq 0) 'INVALID_ARGUMENTS'
        Need ($D.acceptance -is [Array] -and $D.acceptance.Count -gt 0 -and @($D.acceptance | Where-Object { $_ -isnot [string] }).Count -eq 0) 'INVALID_ACCEPTANCE'
    } elseif ($E.kind -eq 'result') {
        Need ($D.outcome -cin @('succeeded','failed','blocked')) 'INVALID_OUTCOME'
        Need ((Is-Integer $D.exit_code) -and $D.summary -is [string] -and $D.summary.Length -gt 0 -and $D.actual_revision -is [string] -and $D.actual_revision.Length -gt 0) 'INVALID_RESULT'
        Need ($D.metrics -is [Collections.IDictionary]) 'INVALID_METRICS'
        Need ($D.outcome -ne 'succeeded' -or $D.exit_code -eq 0) 'SUCCESS_WITH_NONZERO_EXIT'
    } else { Need ($D.status -ceq $E.kind) 'INVALID_CONTROL_PAYLOAD' }
}
function Validate-Event($E) {
    Need ($E -is [Collections.IDictionary] -and $E.schema -ceq 'aiconnector.task.v1' -and $E.namespace -ceq $script:C.namespace) 'INVALID_EVENT_SCHEMA'
    Need ((Valid-Id $E.task_id) -and (Valid-Id $E.run_id) -and (Is-Integer $E.revision) -and $E.revision -ge 1 -and $E.revision -le 2147483647) 'INVALID_RUN_ID'
    Need ($E.kind -cin @('task','accepted','started','result','receipt')) 'INVALID_EVENT_KIND'
    $sender='windows-inner'; $receiver='mac-outer'
    if ($E.kind -in @('task','receipt')) { $sender='mac-outer'; $receiver='windows-inner' }
    Need ($E.sender -ceq $sender -and $E.receiver -ceq $receiver) 'INVALID_EVENT_ROLE'
    Need ($E.event_id -is [string] -and $E.event_id -cmatch '^[a-f0-9]{64}$') 'INVALID_EVENT_ID'
    $unsigned=@{}; foreach ($k in $E.get_Keys()) { if ($k -ne 'event_id') { $unsigned[$k]=$E[$k] } }
    Need ((Hash (Canonical $unsigned)) -ceq $E.event_id) 'EVENT_HASH_MISMATCH'
    Need (($E.kind -eq 'task' -and $E.parent -ceq '') -or ($E.kind -ne 'task' -and $E.parent -cmatch '^[a-f0-9]{64}$')) 'INVALID_PARENT'
    $bytes=[Convert]::FromBase64String($E.payload_b64)
    Need ($bytes.Length -le 16384 -and (Get-Sha256 $bytes) -ceq $E.payload_sha256) 'PAYLOAD_HASH_MISMATCH'
    Validate-Data $E (Payload $E)
}
function New-Event($Identity,[string]$Kind,[string]$Parent,$Data) {
    $raw=$script:Utf8.GetBytes((Canonical $Data))
    $e=@{schema='aiconnector.task.v1';namespace=$script:C.namespace;task_id=$Identity.task_id;revision=$Identity.revision;run_id=$Identity.run_id;kind=$Kind;sender=$Node;receiver=$script:Peer;parent=$Parent;payload_sha256=(Get-Sha256 $raw);payload_b64=[Convert]::ToBase64String($raw)}
    $e.event_id=Hash (Canonical $e); Validate-Event $e; return $e
}
function Display-Text($Text,[int]$Limit=512) {
    $clean=([string]$Text -replace '[|\r\n`<>]',' ')
    if ($clean.Length -gt $Limit) { return $clean.Substring(0,$Limit)+'...' }
    return $clean
}
function Relay-Descriptor {
    return @{schema='aiconnector.relay.v1';repository=$script:C.repository;namespace=$script:C.namespace;layout='task-issues-run-releases-v1';protocol='aiconnector.task.v1';max_artifact_bytes=5242879}
}
function Cached-Metadata([string]$Name) {
    if (-not $script:Resident) { return $null }
    $row=Get-Field $script:MetadataCache $Name
    if ($row -and (Epoch) -lt $row.expires_at) { Trace-Event 'metadata_cached'; return $row.value }
    $script:MetadataCache.Remove($Name); return $null
}
function Cache-Metadata([string]$Name,$Value) {
    # Successful validation only; no disk persistence, negative entries or TTL extension on hits.
    if ($script:Resident) {
        foreach ($id in @($script:MetadataCache.Keys)) { if ($script:MetadataCache[$id].expires_at -le (Epoch)) { $script:MetadataCache.Remove($id) } }
        if ($script:MetadataCache.Count -ge 128) { $old=@($script:MetadataCache.Keys | Sort-Object @{Expression={$script:MetadataCache[$_].expires_at}})[0]; $script:MetadataCache.Remove($old) }
        $script:MetadataCache[$Name]=@{expires_at=((Epoch)+30);value=$Value}
    }
}
function Assert-Relay {
    if (Cached-Metadata 'manifest') { return }
    $r=Api ($script:RepoPath+'/contents/.aiconnector/relay.json'); Require-Response $r
    Need ($r.json.encoding -ceq 'base64') 'INVALID_RELAY_MANIFEST'
    try { $d=Parse ($script:Utf8.GetString([Convert]::FromBase64String($r.json.content))) } catch { Fail 'INVALID_RELAY_MANIFEST' }
    Need ((Canonical $d) -ceq (Canonical (Relay-Descriptor))) 'RELAY_MANIFEST_MISMATCH'
    Cache-Metadata 'manifest' $true
}
function Metadata-Body([string]$Marker,[string]$Text,$Metadata) {
    return $Marker+"`n`n"+$Text+"`n`n"+'```json'+"`n"+(Canonical $Metadata)+"`n"+'```'
}
function Read-Metadata([string]$Body,[string]$Marker) {
    Need ($script:Utf8.GetByteCount($Body) -le 32768) 'INVALID_RELAY_METADATA'
    $pattern='(?s)\A'+[Regex]::Escape($Marker)+'\r?\n.*?```json\r?\n(.*?)\r?\n```\s*\z'
    Need ($Body -match $pattern) 'INVALID_RELAY_METADATA'
    return Parse $Matches[1]
}
function Issue-Metadata([string]$TaskId) {
    return @{schema='aiconnector.task-issue.v1';namespace=$script:C.namespace;task_id=$TaskId;coordinator='mac-outer';worker='windows-inner'}
}
function Read-Routes {
    $stage=Start-Stage 'relay.routes'
    try { Read-Routes-Work  } catch { Trace-Fault $_ 'relay.routes'; throw } finally { Stop-Stage $stage }
}
function Read-Routes-Work {
    $routes=@{}
    foreach ($issue in (Read-List ($script:RepoPath+'/issues') '&state=all&sort=created&direction=asc')) {
        if (([string]$issue.body).StartsWith('AIConnector node capabilities v1') -and -not (Get-Field $issue 'pull_request') -and @($script:C.authors['windows-inner']) -ccontains [string]$issue.user.login) {
            try { $m=Read-Metadata ([string]$issue.body) 'AIConnector node capabilities v1' } catch { continue }
            if ($m.schema -ceq 'aiconnector.capability-issue.v1' -and $m.namespace -ceq $script:C.namespace -and $m.node -ceq 'windows-inner') {
                $old=Get-Field $script:State 'capability_issue'
                Need (-not $old -or $old.number -eq $issue.number) 'DUPLICATE_CAPABILITY_ISSUE'
                $script:State.capability_issue=@{number=$issue.number;url=$issue.html_url}
            }
            continue
        }
        if ((Get-Field $issue 'pull_request') -or -not ([string]$issue.body).StartsWith('AIConnector task issue v1')) { continue }
        if (@($script:C.authors['mac-outer']) -cnotcontains [string]$issue.user.login) { continue }
        try { $m=Read-Metadata ([string]$issue.body) 'AIConnector task issue v1' } catch { continue }
        if ($m.namespace -cne $script:C.namespace) { continue }
        Need ((Valid-Id $m.task_id) -and (Canonical $m) -ceq (Canonical (Issue-Metadata $m.task_id))) 'INVALID_TASK_ISSUE'
        Need (-not $routes.ContainsKey($m.task_id)) 'DUPLICATE_TASK_ISSUE'
        Need ([string]$issue.number -cmatch '^[1-9][0-9]*$') 'INVALID_TASK_ISSUE'
        $route=@{task_id=$m.task_id;number=[string]$issue.number;url=[string]$issue.html_url;digest=(Hash ([string]$issue.body));author=[string]$issue.user.login;created_at=(Source-Time $issue.created_at)}
        if ($script:State.routes.ContainsKey($m.task_id)) {
            $old=$script:State.routes[$m.task_id]
            Need ($old.number -ceq $route.number -and $old.digest -ceq $route.digest -and $old.author -ceq $route.author) 'TASK_ISSUE_CHANGED'
        }
        $routes[$m.task_id]=$route
    }
    foreach ($id in $script:State.routes.Keys) { Need ($routes.ContainsKey($id)) 'TASK_ISSUE_MISSING_OR_CHANGED' }
    $script:State.routes=$routes; Save; Cache-Metadata 'routes' $routes
    return $routes
}
function Read-Capabilities {
    $issue=Get-Field $script:State 'capability_issue'
    if (-not $issue) { return $null }
    $latest=$null
    foreach ($c in (Read-List ($script:RepoPath+'/issues/'+$issue.number+'/comments'))) {
        if (@($script:C.authors['windows-inner']) -cnotcontains [string]$c.user.login -or -not ([string]$c.body).StartsWith('AIConnector capabilities v1')) { continue }
        try { $d=Read-Metadata ([string]$c.body) 'AIConnector capabilities v1' } catch { continue }
        if ($d.schema -cne 'aiconnector.capabilities.v1' -or $d.namespace -cne $script:C.namespace -or $d.node -cne 'windows-inner') { continue }
        if (-not $latest -or [long]$c.id -gt [long]$latest.comment_id) { $latest=@{data=$d;comment_id=$c.id;url=$c.html_url;body_sha256=(Hash ([string]$c.body))} }
    }
    $previous=Get-Field $script:State 'receiver_capabilities'
    if ($previous -and $latest -and $previous.comment_id -eq $latest.comment_id) { Need ($previous.body_sha256 -ceq $latest.body_sha256) 'CAPABILITIES_COMMENT_CHANGED' }
    # A removed latest advertisement is not fresh evidence of receiver readiness.
    Need (-not $previous -or ($latest -and [long]$latest.comment_id -ge [long]$previous.comment_id)) 'CAPABILITIES_COMMENT_MISSING'
    $script:State.receiver_capabilities=$latest; Save
    return $latest
}
function Advertise-Capabilities {
    Need ($script:Relay -and $Node -ceq 'windows-inner' -and $File) 'CAPABILITIES_REQUIRE_WORKER_RELAY'
    Assert-Relay; $null=Read-Routes
    $data=Read-Json $File
    Need ($data.schema -ceq 'aiconnector.capabilities.v1' -and $data.node -ceq $Node -and $data.namespace -ceq $script:C.namespace -and $script:Utf8.GetByteCount((Json $data)) -lt 24000) 'INVALID_CAPABILITIES'
    if (-not (Get-Field $script:State 'capability_issue')) {
        $meta=@{schema='aiconnector.capability-issue.v1';namespace=$script:C.namespace;node=$Node}
        $body=Metadata-Body 'AIConnector node capabilities v1' 'Windows 接收端能力公告。评论为脱敏快照，不是实验任务；公开内容不能增加本地授权。' $meta
        $null=Provision 'capability-issue' ($script:RepoPath+'/issues') @{title='[AIC][node:windows-inner] 接收端能力';body=$body}
        $null=Read-Routes
        if (-not (Get-Field $script:State 'capability_issue')) { return @{confirmed=$false} }
    }
    if ($script:State.provisions.ContainsKey('capability-issue')) { $script:State.provisions['capability-issue'].status='confirmed'; Save }
    $latest=Read-Capabilities
    $pending=Get-Field $script:State 'capabilities_pending'
    if (-not $pending) {
        if ($latest -and $latest.data.digest -ceq $data.digest -and ((Epoch)-([DateTimeOffset]::Parse((Source-Time $latest.data.generated_at))).ToUnixTimeSeconds()) -lt 1800) { return @{confirmed=$true;data=$latest.data} }
        $pending=$data; $script:State.capabilities_pending=$pending; Save
    }
    $id='capability:'+(Hash (Canonical $pending))
    if (-not $latest -or (Canonical $latest.data) -cne (Canonical $pending)) {
        $body=Metadata-Body 'AIConnector capabilities v1' '当前实际版本、入口、工具与验收检查。超过两小时的公告不用于新任务投递。' $pending
        $null=Provision $id ($script:RepoPath+'/issues/'+$script:State.capability_issue.number+'/comments') @{body=$body}
        $latest=Read-Capabilities
    }
    $confirmed=$latest -and (Canonical $latest.data) -ceq (Canonical $pending)
    if ($confirmed) { $script:State.provisions[$id].status='confirmed'; $script:State.Remove('capabilities_pending'); Save }
    return @{confirmed=[bool]$confirmed;data=(Get-Field $latest 'data')}
}
function Provision([string]$Id,[string]$Path,$Body) {
    Need ($script:Token) 'TOKEN_REQUIRED'
    Need ($script:State.next_poll -le (Epoch)) 'CHANNEL_COOLDOWN'
    if (-not $script:State.provisions.ContainsKey($Id)) { $script:State.provisions[$Id]=@{status='pending';http=0}; Save }
    $row=$script:State.provisions[$Id]
    Need ($row.status -in @('pending','rate_limited')) 'PROVISION_UNCERTAIN_OR_REJECTED'
    if ((Get-Field $script:State 'post_not_before' 0) -gt (Epoch)) { return $false }
    $row.status='uncertain'; Save
    $r=Api $Path POST (Json $Body); $row.http=$r.http
    $script:State.post_not_before=(Epoch)+$script:C.write_interval_seconds
    if (Limited $r) { $row.status='rate_limited'; $script:State.next_poll=Cooldown $r; $script:State.last_error='RATE_LIMITED' }
    elseif ($r.http -ge 400 -and $r.http -lt 500) { $row.status='rejected'; $script:State.last_error='PROVISION_REJECTED_'+$r.http }
    Save
    # Even a timeout may have created the object. Only the next independent GET confirms it.
    return $true
}
function Ensure-TaskIssue($E) {
    $routes=Cached-Metadata 'routes'; if (-not $routes -or -not $routes.ContainsKey($E.task_id)) { $routes=Read-Routes }
    $id='issue:'+ $E.task_id
    if ($routes.ContainsKey($E.task_id)) {
        if ($script:State.provisions.ContainsKey($id)) { $script:State.provisions[$id].status='confirmed'; Save }
        return $routes[$E.task_id]
    }
    Need ($E.kind -ceq 'task' -and $Node -ceq 'mac-outer') 'TASK_ISSUE_NOT_FOUND'
    $d=Payload $E
    $title='[AIC]['+$E.task_id+'] '+(Display-Text $d.title 120)
    $text='## '+(Display-Text $d.title 120)+"`n`n"+'任务 ID：`'+$E.task_id+'`；命名空间：`'+$script:C.namespace+'`。'+"`n`n"+
        '初始目标：'+(Display-Text $d.objective 1500)+"`n`n"+'本 Issue 汇集这项任务的全部修订和运行。下方协议评论是追加记录；普通评论、标题、标签与开关状态不触发执行。'+"`n`n"+
        '每次运行对应一个 Release；任务和结果评论提供交付件链接。已领取不等于实验启动，回执不等于实验通过。'
    $body=Metadata-Body 'AIConnector task issue v1' $text (Issue-Metadata $E.task_id)
    $null=Provision $id ($script:RepoPath+'/issues') @{title=$title;body=$body;labels=@('aiconnector:task','aiconnector:protocol-v1')}
    if ($script:State.next_poll -gt (Epoch)) { return $null }
    $routes=Read-Routes
    if ($routes.ContainsKey($E.task_id)) { $script:State.provisions[$id].status='confirmed'; Save; return $routes[$E.task_id] }
    return $null
}
function Identity-FromKey([string]$RunKey) {
    Need ($RunKey -cmatch '^([a-z0-9][a-z0-9_-]{0,63})/([1-9][0-9]{0,9})/([a-z0-9][a-z0-9_-]{0,63})$') 'RUN_KEY_REQUIRED'
    $revision=[long]$Matches[2]; Need ($revision -le 2147483647) 'INVALID_RUN_ID'
    return @{task_id=$Matches[1];revision=$revision;run_id=$Matches[3]}
}
function Run-Tag($E) { return 'aic-v1.'+$script:C.namespace+'.'+$E.task_id+'.r'+$E.revision+'.'+$E.run_id }
function Release-Metadata($E) { return @{schema='aiconnector.run-release.v1';namespace=$script:C.namespace;task_id=$E.task_id;revision=$E.revision;run_id=$E.run_id} }
function Release-Link($E) {
    return 'https://github.com/'+$script:C.repository+'/releases/tag/'+(Run-Tag $E)
}
function Ensure-RunRelease($E,[bool]$IdentityCache=$false) {
    $tag=Run-Tag $E; $id='release:'+(Run-Key $E)
    if ($IdentityCache) { $cached=Cached-Metadata $id; if ($cached) { return $cached } }
    $r=Api ($script:RepoPath+'/releases/tags/'+$tag)
    if ($r.http -eq 404) {
        $text='运行：`'+(Run-Key $E)+'`。'+"`n`n"+'任务记录： https://github.com/'+$script:C.repository+'/issues?q='+[Uri]::EscapeDataString('[AIC]['+$E.task_id+']')+"`n`n"+
            'input--mac-outer--SHA256.zip 为输入；result--windows-inner--SHA256.zip 为结果。每个文件小于 5 MiB；已上传文件不覆盖。文件名中的完整 SHA-256 与任务/结果评论中的清单对应。'
        $body=Metadata-Body 'AIConnector run release v1' $text (Release-Metadata $E)
        $null=Provision $id ($script:RepoPath+'/releases') @{tag_name=$tag;name=('[AIC]['+$E.task_id+'][r'+$E.revision+']['+$E.run_id+']');body=$body;draft=$false;prerelease=$true;make_latest='false';target_commitish='main'}
        if ($script:State.next_poll -gt (Epoch)) { return $null }
        $r=Api ($script:RepoPath+'/releases/tags/'+$tag)
        if ($r.http -eq 404) { return $null }
    }
    Require-Response $r; $release=$r.json
    Need ($release.id -and -not $release.draft -and $release.tag_name -ceq $tag) 'INVALID_RUN_RELEASE'
    Need (@($script:C.authors['mac-outer']) -ccontains [string]$release.author.login -or @($script:C.authors['windows-inner']) -ccontains [string]$release.author.login) 'RELEASE_AUTHOR_NOT_ALLOWED'
    $m=Read-Metadata ([string]$release.body) 'AIConnector run release v1'
    Need ((Canonical $m) -ceq (Canonical (Release-Metadata $E))) 'RELEASE_IDENTITY_MISMATCH'
    $digest=Hash ([string]$release.body)
    if ($script:State.provisions.ContainsKey($id)) {
        $previous=Get-Field $script:State.provisions[$id] 'digest'
        Need (-not $previous -or $previous -ceq $digest) 'RUN_RELEASE_CHANGED'
    } else { $script:State.provisions[$id]=@{http=200} }
    $script:State.provisions[$id].status='confirmed'; $script:State.provisions[$id].digest=$digest; Save
    Cache-Metadata $id $release
    return $release
}
function Event-Body($E) {
    $labels=@{task='待接收';accepted='已接收';started='已领取执行';result='结果已回传';receipt='结果已校验'}
    $d=Payload $E; $summary=$d.title; if ($E.kind -eq 'result') { $summary=$d.summary }
    $summary=([string]$summary -replace '[\r\n`<>]',' '); if ($summary.Length -gt 240) { $summary=$summary.Substring(0,240) }
    $details=@()
    if ($script:Relay) { $details+=('运行文件：['+(Run-Tag $E)+']('+(Release-Link $E)+')') }
    if ($E.kind -eq 'task') {
        $details+=('目标：'+(Display-Text $d.objective 1500))
        $details+=('代码：'+(Display-Text $d.code.repository)+' @ '+(Display-Text $d.code.revision))
        $details+=('环境：'+(Display-Text $d.environment.target))
        $details+=('入口：'+(Display-Text $d.invocation.entry)+' '+(Display-Text ($d.invocation.arguments -join ' ')))
        $details+=('验收：'+(Display-Text ($d.acceptance -join '；') 1500))
    } elseif ($E.kind -eq 'result') {
        $details+=('结果：'+$d.outcome+'；退出码：'+$d.exit_code+'；实际版本：'+(Display-Text $d.actual_revision))
        $details+=('指标：'+(Display-Text (Json $d.metrics) 1024))
    }
    if ($E.kind -in @('task','result')) { foreach ($a in $d.artifacts) { $details+=('ZIP：['+$a.name+']('+$a.url+')，'+$a.bytes+' 字节，SHA-256 '+$a.sha256) } }
    $body='AIConnector task v1'+"`n`n"+'**'+$labels[$E.kind]+'** · '+(Run-Key $E)+' · '+$E.sender+' → '+$E.receiver+"`n`n"+$summary+"`n`n"+($details -join "`n`n")+"`n`n"+'```json'+"`n"+(Canonical $E)+"`n"+'```'
    Need ($script:Utf8.GetByteCount($body) -le 32768) 'COMMENT_TOO_LARGE'; return $body
}
function Queue($E) {
    # The durable event ledger owns deduplication even after a closed run's
    # redundant delivery bookkeeping has been compacted.
    if ($script:State.events.ContainsKey($E.event_id)) { return }
    $body=Event-Body $E
    if ($script:State.outbox.ContainsKey($E.event_id)) { return }
    $script:State.outbox[$E.event_id]=@{event=$E;body=$body;status='pending';attempts=0;http=0;queued_at=(Epoch)}
    Save
    Trace-Event 'event_queued' @{key=(Run-Key $E);event_id=$E.event_id;event_kind=$E.kind}
}
function Start-DeliveryWrite($Row) {
    # Persist intent before the network call. Recovery may resend only these
    # immutable deliveries, never a Claim, SSH command, or arbitrary POST.
    $Row.status='uncertain'; $Row.last_attempt_at=Epoch
    $Row.attempts=1+[int](Get-Field $Row 'attempts' 0)
    $Row.Remove('recovery'); Save
}
function Observe-DeliveryAbsent($Row) {
    if ($Row.status -ne 'uncertain') { return }
    $now=Epoch
    if (-not (Get-Field $Row 'recovery')) {
        $attempt=[long](Get-Field $Row 'last_attempt_at' $now)
        # Legacy rows without a timestamp start their observation window now.
        if ($attempt -le 0) { $attempt=$now }
        $base=[Math]::Max(2*$TimeoutSeconds,[Math]::Max(2*$script:C.poll_seconds,$script:C.write_interval_seconds))
        $delay=[Math]::Min(3600,$base*[Math]::Pow(2,[Math]::Min(5,[Math]::Max(0,[int](Get-Field $Row 'attempts' 1)-1))))
        $Row.recovery=@{absent_reads=0;last_absent_at=0L;not_before=($attempt+[long]$delay)}
    }
    $check=$Row.recovery
    if ($check.last_absent_at -gt 0 -and $now-$check.last_absent_at -lt $script:C.poll_seconds) { return }
    $check.absent_reads++; $check.last_absent_at=$now
    if ($check.absent_reads -ge 2 -and $now -ge $check.not_before) {
        $Row.status='pending'; $check.requeued_at=$now
        $Row.recoveries=1+[int](Get-Field $Row 'recoveries' 0)
    }
}
function Reset-DeliveryAbsence($Row) {
    $check=Get-Field $Row 'recovery'
    if ($check) { $check.absent_reads=0; $check.last_absent_at=0L }
}
function Import-Comments($Comments) {
    foreach ($c in $Comments) {
        $id=[string]$c.id; $body=[string]$c.body; $digest=Hash $body
        if ($script:State.comments.ContainsKey($id)) {
            $old=$script:State.comments[$id]
            if ($old.digest -cne $digest -or $old.author -cne [string]$c.user.login -or ($script:Relay -and $old.issue -cne [string]$c.relay_issue)) { $script:State.conflicts[$old.key]='COMMENT_CHANGED' }
            else { $old.created_at=Source-Time $c.created_at; $old.updated_at=Source-Time $c.updated_at }
            continue
        }
        if (-not $body.StartsWith('AIConnector task v1')) { continue }
        try {
            Need ($body -match '(?s)\AAIConnector task v1\r?\n.*?```json\r?\n(.*?)\r?\n```\s*\z' -and $script:Utf8.GetByteCount($body) -le 32768) 'INVALID_FRAME'
            $e=Parse $Matches[1]; Validate-Event $e
            Need (@($script:C.authors[$e.sender]) -ccontains [string]$c.user.login) 'AUTHOR_NOT_ALLOWED'
            if ($script:Relay) { Need ($e.task_id -ceq $c.relay_task_id) 'EVENT_ISSUE_MISMATCH' }
            $key=Run-Key $e
            if (-not $script:State.events.ContainsKey($e.event_id)) { Trace-Event 'event_observed' @{key=$key;event_id=$e.event_id;event_kind=$e.kind} }
            $script:State.events[$e.event_id]=$e
            $script:State.comments[$id]=@{digest=$digest;key=$key;event_id=$e.event_id;author=[string]$c.user.login;issue=[string]$c.relay_issue;created_at=(Source-Time $c.created_at);updated_at=(Source-Time $c.updated_at);url=[string]$c.html_url;observed_at=(Epoch)}
        } catch { $script:State.ignored[$id]='INVALID_OR_UNTRUSTED_EVENT' }
    }
    foreach ($item in $script:State.outbox.Values) {
        if ($script:State.events.ContainsKey($item.event.event_id)) {
            if ($item.status -ne 'confirmed') { $item.confirmed_at=Epoch; Trace-Event 'event_confirmed' @{key=(Run-Key $item.event);event_id=$item.event.event_id;event_kind=$item.event.kind;confirmed_at=$item.confirmed_at} }
            $item.status='confirmed'
        }
    }
    $null=Compact-ConfirmedOutbox
    Save
}
function Compact-ConfirmedOutbox {
    $ids=@($script:State.outbox.Keys | Where-Object { $script:State.outbox[$_].status -ceq 'confirmed' -and $script:State.events.ContainsKey($_) })
    if ($ids.Count -eq 0) { return 0 }
    $runs=Runs; $removed=0
    foreach ($id in $ids) {
        $item=$script:State.outbox[$id]; $key=Run-Key $item.event; $run=Get-Field $runs $key
        # Preserve pending, uncertain, rejected, conflicted and unclosed runs.
        # Events/comments/claims remain the receipt and ownership evidence.
        if (-not $run -or $run.phase -cne 'receipt' -or $run.error) { continue }
        if ((Canonical $item.event) -cne (Canonical $script:State.events[$id])) { continue }
        $script:State.outbox.Remove($id); $removed++
    }
    if ($removed -gt 0) { Trace-Event 'outbox_compacted' @{entries_removed=$removed} }
    return $removed
}
function Read-TaskComments($Route) {
    $all=@()
    foreach ($comment in (Read-List ($script:RepoPath+'/issues/'+$Route.number+'/comments'))) {
        $row=As-Map $comment; $row.relay_task_id=$Route.task_id; $row.relay_issue=$Route.number; $all+=,$row
    }
    return ,$all
}
function Refresh-PollCatalog {
    Assert-Relay; $routes=Read-Routes
    $script:State.sync.catalog_checked_at=Epoch; Save
    return $routes
}
function Import-IncrementalComments {
    $stage=Start-Stage 'poll.import'
    try { Import-IncrementalComments-Work  } catch { Trace-Fault $_ 'poll.import'; throw } finally { Stop-Stage $stage }
}
function Import-IncrementalComments-Work {
    $routes=$script:State.routes
    if ((Epoch)-(Get-Field $script:State.sync 'catalog_checked_at' 0) -ge 60) { $routes=Refresh-PollCatalog }
    $byIssue=@{}
    foreach ($route in $routes.Values) { $byIssue[$script:C.api_base.TrimEnd('/')+$script:RepoPath+'/issues/'+$route.number]=$route }
    $query='&sort=created&direction=asc'; $cursor=[long](Get-Field $script:State.sync 'cursor' 0)
    if ($cursor -gt 0) {
        $since=[DateTimeOffset]::FromUnixTimeSeconds([Math]::Max(0,$cursor-[Math]::Max(120,2*$script:C.poll_seconds))).UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'")
        $query+='&since='+[Uri]::EscapeDataString($since)
    }
    # No import or cursor advance unless the entire stable-order page set succeeded.
    $comments=Read-List ($script:RepoPath+'/issues/comments') $query; $all=@(); $next=$cursor
    # Discover a new task immediately, without refreshing every historical route
    # on each fast poll. Only allowed protocol authors can request this refresh.
    $unknown=@($comments | Where-Object {
        -not $byIssue.ContainsKey([string](Get-Field $_ 'issue_url')) -and
        ([string]$_.body).StartsWith('AIConnector task v1') -and
        (@($script:C.authors['mac-outer'])+@($script:C.authors['windows-inner'])) -ccontains [string]$_.user.login
    })
    $newCapability=@($comments | Where-Object {
        -not (Get-Field $script:State 'capability_issue') -and
        ([string]$_.body).StartsWith('AIConnector capabilities v1') -and
        @($script:C.authors['windows-inner']) -ccontains [string]$_.user.login
    })
    if ($unknown.Count -gt 0 -or $newCapability.Count -gt 0) {
        $routes=Refresh-PollCatalog; $byIssue=@{}
        foreach ($route in $routes.Values) { $byIssue[$script:C.api_base.TrimEnd('/')+$script:RepoPath+'/issues/'+$route.number]=$route }
    }
    foreach ($comment in $comments) {
        $time=[DateTimeOffset]::MinValue
        if ([DateTimeOffset]::TryParse((Source-Time (Get-Field $comment 'updated_at')),[ref]$time)) { $next=[Math]::Max($next,$time.ToUnixTimeSeconds()) }
        if (([string]$comment.body).StartsWith('AIConnector capabilities v1') -and
            @($script:C.authors['windows-inner']) -ccontains [string]$comment.user.login -and
            [long]$comment.id -gt [long](Get-Field (Get-Field $script:State 'receiver_capabilities') 'comment_id' 0)) { $script:State.sync.capabilities_dirty=$true }
        $route=Get-Field $byIssue ([string](Get-Field $comment 'issue_url'))
        if (-not $route) { continue }
        $row=As-Map $comment; $row.relay_task_id=$route.task_id; $row.relay_issue=$route.number; $all+=,$row
    }
    Import-Comments $all
    $script:State.sync.cursor=$next; $script:State.sync.updated_at=Epoch; Save
}
function Audit-OneRoute {
    $stage=Start-Stage 'poll.audit'
    try { Audit-OneRoute-Work  } catch { Trace-Fault $_ 'poll.audit'; throw } finally { Stop-Stage $stage }
}
function Audit-OneRoute-Work {
    if ((Epoch)-(Get-Field $script:State.sync 'audit_checked_at' 0) -lt 60) { return }
    $routes=@($script:State.routes.Values | Sort-Object task_id)
    if ($routes.Count -eq 0) { return }
    $index=[int](Get-Field $script:State.sync 'audit_index' 0)%$routes.Count; $route=$routes[$index]
    # Advance even on an unavailable old route, so it cannot monopolize the audit.
    $script:State.sync.audit_index=($index+1)%$routes.Count; $script:State.sync.audit_checked_at=Epoch; Save
    try {
        $null=In-Scope ('audit:'+$route.task_id) {
            $comments=Read-TaskComments $route; Import-Comments $comments
            $present=@{}; foreach ($c in $comments) { $present[[string]$c.id]=$true }
            foreach ($id in @($script:State.comments.Keys)) {
                $old=$script:State.comments[$id]
                if ($old.issue -ceq $route.number -and -not $present.ContainsKey($id)) { $script:State.conflicts[$old.key]='COMMENT_MISSING' }
            }
        }
        $script:State.sync.Remove('audit_error'); Save
    } catch {
        if ($script:State.next_poll -gt (Epoch)) { throw }
        $script:State.sync.audit_error=Error-Code $_; Save
    }
}
function Reconcile-DeliveryComments([string]$TaskId='') {
    try {
        if ($script:Relay -and $TaskId) {
            $route=Get-Field $script:State.routes $TaskId; Need ($null -ne $route) 'TASK_ISSUE_NOT_FOUND'
            Import-Comments (Read-TaskComments $route)
        } else { Import-Comments (Read-Comments) }
    } catch {
        foreach ($item in $script:State.outbox.Values) { if (-not $TaskId -or $item.event.task_id -ceq $TaskId) { Reset-DeliveryAbsence $item } }
        Save; throw
    }
    foreach ($item in $script:State.outbox.Values) {
        if ($TaskId -and $item.event.task_id -cne $TaskId) { continue }
        if ($script:Relay -and -not $script:State.routes.ContainsKey($item.event.task_id)) { continue }
        if (-not $script:State.events.ContainsKey($item.event.event_id)) { Observe-DeliveryAbsent $item }
    }
    $script:State.last_delivery_reconcile=Epoch
    Save
}
function Confirm-PostedComment($Item,$Response) {
    if (-not $script:Relay) { Reconcile-DeliveryComments; return }
    $e=$Item.event; $route=$script:State.routes[$e.task_id]
    $commentId=[string](Get-Field $Response.json 'id')
    if ($Response.status -ceq 'HTTP_OK' -and $commentId -cmatch '^[1-9][0-9]*$') {
        $r=Api ($script:RepoPath+'/issues/comments/'+$commentId)
        if ($r.http -ne 404) {
            Require-Response $r
            Need ([string]$r.json.id -ceq $commentId -and [string]$r.json.issue_url -ceq ($script:C.api_base.TrimEnd('/')+$script:RepoPath+'/issues/'+$route.number)) 'POST_READBACK_MISMATCH'
            Need ((Hash ([string]$r.json.body)) -ceq (Hash $Item.body)) 'POST_READBACK_MISMATCH'
            $row=As-Map $r.json; $row.relay_task_id=$route.task_id; $row.relay_issue=$route.number
            Import-Comments @($row); return
        }
    }
    # Ambiguous POST / delayed visibility: search only this task, preserving the
    # independent reads + absence window before an immutable delivery may retry.
    Reconcile-DeliveryComments $e.task_id
}
function Revision-Digest($E) {
    if (-not $script:Relay) { return $E.payload_sha256 }
    $data=Payload $E
    # A repeat run has its own Release URL; the immutable input is still the same bytes.
    foreach ($a in $data.artifacts) { $a.Remove('url') }
    return Hash (Canonical $data)
}
function Runs {
    $stage=Start-Stage 'runs.project'
    try { Runs-Work  } catch { Trace-Fault $_ 'runs.project'; throw } finally { Stop-Stage $stage }
}
function Runs-Work {
    $result=@{}
    foreach ($e in $script:State.events.Values) {
        $key=Run-Key $e
        if (-not $result.ContainsKey($key)) { $result[$key]=@{key=$key;phase='waiting_parent';events=@{};error=''} }
        $run=$result[$key]
        if ($run.events.ContainsKey($e.kind) -and $run.events[$e.kind].event_id -cne $e.event_id) { $script:State.conflicts[$key]='CONFLICTING_EVENT' }
        $run.events[$e.kind]=$e
    }
    $revisions=@{}
    foreach ($run in $result.Values) {
        if (-not $run.events.ContainsKey('task')) { continue }
        $task=$run.events.task; $revisionKey=$task.task_id+'/'+$task.revision
        $digest=Revision-Digest $task
        if (-not $revisions.ContainsKey($revisionKey)) { $revisions[$revisionKey]=@{sha=$digest;keys=@();conflict=$false} }
        $group=$revisions[$revisionKey]; $group.keys+=,$run.key
        if ($group.sha -cne $digest) { $group.conflict=$true }
    }
    foreach ($group in $revisions.Values) { if ($group.conflict) { foreach ($runKey in $group.keys) { $script:State.conflicts[$runKey]='REVISION_CONFLICT' } } }
    foreach ($run in $result.Values) {
        if ($script:State.conflicts.ContainsKey($run.key)) { $run.phase='conflict'; $run.error=$script:State.conflicts[$run.key]; continue }
        $previous=''; $phase='waiting_parent'
        foreach ($kind in @('task','accepted','started','result','receipt')) {
            if (-not $run.events.ContainsKey($kind)) { break }
            $e=$run.events[$kind]
            if ($e.parent -cne $previous) { $run.error='PARENT_MISMATCH'; $phase='conflict'; break }
            $previous=$e.event_id; $phase=$kind
        }
        $run.phase=$phase
        if ($run.events.ContainsKey('task')) { $run.task=Payload $run.events.task }
        if ($run.events.ContainsKey('result')) { $run.result=Payload $run.events.result }
        if ($script:State.claims.ContainsKey($run.key)) { $run.local_claim=$script:State.claims[$run.key] }
        if ($script:State.artifact_errors.ContainsKey($run.key)) { $run.error=$script:State.artifact_errors[$run.key] }
    }
    return $result
}
function Write-Bytes([string]$Path,[byte[]]$Data) {
    $tmp=$Path+'.'+[Guid]::NewGuid().ToString('N')+'.tmp'
    try {
        $f=[IO.File]::Open($tmp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try { $f.Write($Data,0,$Data.Length); $f.Flush($true) } finally { $f.Dispose() }
        if ([IO.File]::Exists($Path)) { [IO.File]::Replace($tmp,$Path,[NullString]::Value) } else { [IO.File]::Move($tmp,$Path) }
    } finally { if ([IO.File]::Exists($tmp)) { [IO.File]::Delete($tmp) } }
}
function Fetch-Artifacts($Artifacts,[bool]$Refresh=$false) {
    $stage=Start-Stage 'artifact.verify'
    try { Fetch-Artifacts-Work $Artifacts $Refresh } catch { Trace-Fault $_ 'artifact.verify'; throw } finally { Stop-Stage $stage }
}
function Fetch-Artifacts-Work($Artifacts,[bool]$Refresh=$false) {
    $paths=@()
    foreach ($a in $Artifacts) {
        Artifact-Valid $a
        $cache=Join-Path $StateDir 'artifacts'; [IO.Directory]::CreateDirectory($cache)|Out-Null
        $path=Join-Path $cache ($a.sha256+'.zip'); $valid=$false
        if ([IO.File]::Exists($path)) { $bytes=[IO.File]::ReadAllBytes($path); $valid=($bytes.Length -eq $a.bytes -and (Get-Sha256 $bytes) -ceq $a.sha256) }
        if ($Refresh -or -not $valid) {
            Trace-Event 'artifact_download_started' @{bytes=$a.bytes}
            $r=Invoke-WireHttp -Url $a.url -Limit 5242879
            Require-Response $r
            Need ($r.bytes -eq $a.bytes -and $r.sha256 -ceq $a.sha256) 'ARTIFACT_HASH_MISMATCH'
            Write-Bytes $path $r.data
            Trace-Event 'artifact_verified' @{bytes=$a.bytes}
        }
        $paths+=@{name=$a.name;path=$path;sha256=$a.sha256;bytes=$a.bytes}
    }
    return ,$paths
}
function Auto-Transitions {
    $stage=Start-Stage 'transition.prepare'
    try { Auto-Transitions-Work  } catch { Trace-Fault $_ 'transition.prepare'; throw } finally { Stop-Stage $stage }
}
function Auto-Transitions-Work {
    if ($script:State.next_poll -gt (Epoch)) { return }
    $runs=Runs
    foreach ($run in $runs.Values) {
        $kind=''; $parent=$null; $artifacts=@()
        if ($Node -eq 'windows-inner' -and $run.phase -eq 'task') { $kind='accepted'; $parent=$run.events.task; $artifacts=$run.task.artifacts }
        if ($Node -eq 'mac-outer' -and $run.phase -eq 'result') { $kind='receipt'; $parent=$run.events.result; $artifacts=$run.result.artifacts }
        if (-not $kind) { continue }
        # An immutable pending delivery already represents verified inputs. Its
        # durable outbox survives restarts; Claim still verifies bytes before execution.
        $existing=@($script:State.outbox.Values | Where-Object { $_.event.kind -ceq $kind -and $_.event.parent -ceq $parent.event_id })
        if ($existing.Count -gt 0) { continue }
        try {
            if ($kind -eq 'receipt' -and $run.result.outcome -eq 'succeeded') { Need ($run.result.actual_revision -ceq $run.task.code.revision) 'RESULT_REVISION_MISMATCH' }
            $null=In-Scope ('artifact:'+$run.key) { Fetch-Artifacts $artifacts }
            if ($kind -eq 'accepted') { Trace-Event 'acceptance_inputs_verified' @{key=$run.key} }
            $script:State.artifact_errors.Remove($run.key)
            Queue (New-Event $parent $kind $parent.event_id @{status=$kind})
        } catch {
            $code=[string]$_.Exception.Data['connector_code']; if (-not $code) { $code='ARTIFACT_NOT_VERIFIED' }
            $script:State.artifact_errors[$run.key]=$code
            if ($script:State.next_poll -gt (Epoch)) { throw }
        }
    }
    Save
}
function Flush-One([bool]$Reconciled=$false) {
    $stage=Start-Stage 'outbox.send'
    try { Flush-One-Work $Reconciled } catch { Trace-Fault $_ 'outbox.send'; throw } finally { Stop-Stage $stage }
}
function Flush-One-Work([bool]$Reconciled=$false) {
    if ($script:State.next_poll -gt (Epoch)) { return }
    if ((Get-Field $script:State 'post_not_before' 0) -gt (Epoch)) { return }
    $runs=Runs; $manifestChecked=$false
    foreach ($id in @($script:State.outbox.Keys | Sort-Object @{Expression={
        $kind=$script:State.outbox[$_].event.kind
        if ($kind -in @('started','result','receipt')) { 0 } else { 1 }
    }},@{Expression={Get-Field $script:State.outbox[$_] 'last_attempt_at' 0}},@{Expression={Get-Field $script:State.outbox[$_] 'queued_at' 0}},@{Expression={$_}})) {
        $item=$script:State.outbox[$id]; $e=$item.event; $key=Run-Key $e
        if ($item.status -notin @('pending','rate_limited','uncertain')) { continue }
        if ($script:State.conflicts.ContainsKey($key) -or ($runs.ContainsKey($key) -and $runs[$key].phase -eq 'conflict')) { continue }
        if ($e.parent -and -not $script:State.events.ContainsKey($e.parent)) { continue }
        $scope='delivery:'+$e.task_id
        $cool=Get-Field $script:State.scopes $scope
        if ($script:Relay -and $cool -and $cool.next_attempt -gt (Epoch)) { continue }
        $previous=$script:IoScope; $script:IoScope=$scope
        try {
            if ($item.status -eq 'uncertain' -or ($item.status -eq 'pending' -and (Get-Field $item 'recovery'))) {
                if ($script:Relay) {
                    $check=Get-Field $item 'recovery'
                    if ($check -and (Epoch)-$check.last_absent_at -lt $script:C.poll_seconds) { continue }
                    Reconcile-DeliveryComments $e.task_id
                } elseif (-not $Reconciled) { Reconcile-DeliveryComments; $Reconciled=$true }
                if ($item.status -notin @('pending','rate_limited')) { continue }
            }
            if (-not $script:Token) { $script:State.last_error='TOKEN_REQUIRED'; Save; return }
            $commentsPath=$script:CommentsPath
            if ($script:Relay) {
                if (-not $manifestChecked) { Assert-Relay; $manifestChecked=$true }
                $route=Ensure-TaskIssue $e; if ($null -eq $route) { return }
                if ((Get-Field $script:State 'post_not_before' 0) -gt (Epoch)) { return }
                $release=Ensure-RunRelease $e $true; if ($null -eq $release) { return }
                if ((Get-Field $script:State 'post_not_before' 0) -gt (Epoch)) { return }
                $commentsPath=$script:RepoPath+'/issues/'+$route.number+'/comments'
            }
            Start-DeliveryWrite $item
            $r=Api $commentsPath 'POST' (Json @{body=$item.body})
            $item.http=$r.http
            $script:State.post_not_before=(Epoch)+$script:C.write_interval_seconds
            if (Limited $r) {
                $item.status='rate_limited'; $script:State.failures++; $script:State.next_poll=Cooldown $r; $script:State.last_error='RATE_LIMITED'
            } elseif ($r.http -ge 400 -and $r.http -lt 500) { $item.status='rejected'; $script:State.last_error='WRITE_REJECTED_'+$r.http }
            Save
            if ($script:State.next_poll -le (Epoch)) { Confirm-PostedComment $item $r; $script:State.scopes.Remove($scope); Save }
            return $true
        } catch {
            $item.error=Error-Code $_; Save
            if (-not $script:Relay -or $script:State.next_poll -gt (Epoch) -or -not $script:State.scopes.ContainsKey($scope)) { throw }
            # A route-local failure leaves this immutable delivery pending/uncertain.
            # The next eligible task may proceed without waiting for this route.
        } finally { $script:IoScope=$previous }
    }
}
function Flush-Batch {
    # Preserve parent order and persisted write pacing. Never wait out backoff.
    $watch=[Diagnostics.Stopwatch]::StartNew(); $sent=0
    $limit=4; if ($script:Resident) { $limit=1 }
    for ($n=0;$n -lt $limit;$n++) {
        if ($n -gt 0) {
            $delay=[Math]::Max(0,(Get-Field $script:State 'post_not_before' 0)-(Epoch))
            if ($delay -gt 1 -or $watch.Elapsed.TotalSeconds+$delay -ge 5) { break }
            if ($delay -gt 0) { Start-Sleep -Milliseconds ([int]($delay*1000)) }
        }
        if ($watch.Elapsed.TotalSeconds -ge 5 -or -not (Flush-One)) { break }
        $sent++
    }
    Trace-Event 'flush_batch' @{elapsed_ms=[long]$watch.Elapsed.TotalMilliseconds;events_sent=$sent}
}
function Project-Changed([string]$Path,[string]$Text) {
    $digest=Hash $Text
    if (-not $script:ProjectionHashes.ContainsKey($Path) -and [IO.File]::Exists($Path)) {
        $script:ProjectionHashes[$Path]=Hash ([IO.File]::ReadAllText($Path,$script:Utf8))
    }
    if ((Get-Field $script:ProjectionHashes $Path) -ceq $digest -and [IO.File]::Exists($Path)) { return }
    Atomic $Path $Text; $script:ProjectionHashes[$Path]=$digest; $script:ProjectionWrites++
}
function Snapshot {
    $stage=Start-Stage 'snapshot.build'
    try { Snapshot-Work  } catch { Trace-Fault $_ 'snapshot.build'; throw } finally { Stop-Stage $stage }
}
function Snapshot-Work {
    $watch=[Diagnostics.Stopwatch]::StartNew(); $script:ProjectionWrites=0
    # Include unsaved in-memory changes before comparing the cached projection.
    Save
    if ($script:Resident -and $null -ne $script:SnapshotCache -and $script:SnapshotStateHash -ceq $script:SavedStateHash) {
        Trace-Event 'snapshot_cached' @{elapsed_ms=[long]$watch.Elapsed.TotalMilliseconds;files_written=0}
        return $script:SnapshotCache
    }
    $runs=Runs; $list=@(); $inbox=Join-Path $StateDir 'inbox'; [IO.Directory]::CreateDirectory($inbox)|Out-Null
    $sourcesByEvent=@{}
    foreach ($source in $script:State.comments.Values) {
        $id=[string]$source.event_id; if (-not $id) { continue }
        $previous=Get-Field $sourcesByEvent $id
        if (-not $previous -or ([string]$source.created_at -clt [string]$previous.created_at) -or
            ([string]$source.created_at -ceq [string]$previous.created_at -and [string]$source.url -clt [string]$previous.url)) { $sourcesByEvent[$id]=$source }
    }
    foreach ($run in @($runs.Values | Sort-Object key)) {
        $row=@{key=$run.key;phase=$run.phase;error=$run.error;task=(Get-Field $run 'task');result=(Get-Field $run 'result');claimed=$script:State.claims.ContainsKey($run.key);inbox_file=(Join-Path $inbox ((Hash $run.key)+'.json'))}
        $row.timeline=@()
        foreach ($kind in @('task','accepted','started','result','receipt')) {
            if (-not $run.events.ContainsKey($kind)) { continue }
            $e=$run.events[$kind]
            $source=Get-Field $sourcesByEvent $e.event_id
            $row.timeline+=@{kind=$kind;sender=$e.sender;event_id=$e.event_id;author=(Get-Field $source 'author');published_at=(Source-Time (Get-Field $source 'created_at'));observed_at=(Get-Field $source 'observed_at');url=(Get-Field $source 'url')}
        }
        if ($script:Relay -and $run.events.ContainsKey('task')) {
            $task=$run.events.task; $route=Get-Field $script:State.routes $task.task_id
            $row.issue_url=Get-Field $route 'url'; $row.release_url=Release-Link $task
        }
        $row.local_artifacts=@()
        foreach ($which in @('task','result')) {
            $d=Get-Field $run $which
            if ($d) { foreach ($a in $d.artifacts) { $row.local_artifacts+=@{name=$a.name;path=(Join-Path (Join-Path $StateDir 'artifacts') ($a.sha256+'.zip'))} } }
        }
        Project-Changed $row.inbox_file (Json $row); $list+=,$row
    }
    $outbox=@(); foreach ($item in $script:State.outbox.Values) { $outbox+=@{event_id=$item.event.event_id;key=(Run-Key $item.event);kind=$item.event.kind;status=$item.status;attempts=$item.attempts;http=$item.http;queued_at=(Get-Field $item 'queued_at');recovery=(Get-Field $item 'recovery');recoveries=(Get-Field $item 'recoveries' 0)} }
    $snapshot=@{schema='aiconnector.status.v1';node=$Node;runs=$list;outbox=$outbox;uploads=$script:State.uploads;provisions=$script:State.provisions;next_poll=$script:State.next_poll;last_poll=$script:State.last_poll;last_error=$script:State.last_error;scopes=$script:State.scopes;sync=$script:State.sync;ignored_comments=$script:State.ignored.Count;receiver_capabilities=(Get-Field $script:State 'receiver_capabilities')}
    Project-Changed (Join-Path $StateDir 'status.json') (Json $snapshot)
    $lines=@('# AIConnector '+$Node,'','| 运行 | 状态 | 本地已领取 | 异常 |','|---|---|---|---|')
    foreach ($r in $list) { $lines+='| '+$r.key+' | '+$r.phase+' | '+$r.claimed+' | '+$r.error+' |' }
    $pending=@($outbox | Where-Object { $_.status -ne 'confirmed' })
    $lines+=@('','未确认消息：'+$pending.Count,'最后通道异常：'+$script:State.last_error,'','回执只确认结果和产物完整收到；实验结论由 AI 或人评估。')
    Project-Changed (Join-Path $StateDir 'status.md') ($lines -join "`n")
    # Runs can discover a conflict while constructing this projection.
    Save; $script:SnapshotCache=$snapshot; $script:SnapshotStateHash=$script:SavedStateHash
    Trace-Event 'snapshot_built' @{elapsed_ms=[long]$watch.Elapsed.TotalMilliseconds;files_written=$script:ProjectionWrites}; return $snapshot
}
function Poll-Once {
    if ($script:State.next_poll -gt (Epoch)) { return Snapshot }
    if ($script:Relay) {
        $null=In-Scope 'poll' {
            Import-IncrementalComments
            if ((Get-Field $script:State 'capability_issue') -and
                ((Get-Field $script:State.sync 'capabilities_dirty' $false) -or (Epoch)-(Get-Field $script:State.sync 'capabilities_checked_at' 0) -ge 60)) {
                $null=Read-Capabilities; $script:State.sync.capabilities_checked_at=Epoch; $script:State.sync.Remove('capabilities_dirty'); Save
            }
        }
        if (-not $script:Resident) { Audit-OneRoute }
    } else { Reconcile-DeliveryComments }
    $script:State.last_poll=Epoch; $script:State.last_error=''; $script:State.next_poll=0L
    Auto-Transitions
    # Return discovery/admission state before a slow write. The service drives
    # Flush separately; the standalone Poll/Watch contract still sends one event.
    if (-not $script:Resident) { $null=Flush-One $true }
    if (-not $script:State.last_error) { $script:State.failures=0 }
    return Snapshot
}
function Read-UploadAssets($Release,$Row) {
    try {
        $assets=@(); $complete=$false
        for ($page=1;$page -le $script:C.max_pages;$page++) {
            $r=Api ('/repos/'+$script:C.repository+'/releases/'+$Release.id+'/assets?per_page=100&page='+$page); Require-Response $r
            Need ($r.json -is [Array]) 'INVALID_ASSET_LIST'; $assets+=@($r.json)
            if ($r.json.Count -lt 100) { $complete=$true; break }
        }
        Need $complete 'PAGINATION_INCOMPLETE'
        $found=@($assets | Where-Object { $_.name -ceq $Row.name })
        Need ($found.Count -le 1) 'ASSET_CONFLICT'
        return ,$found
    } catch { Reset-DeliveryAbsence $Row; Save; throw }
}
function Upload-Zip([string]$Path,[bool]$Diagnostics=$false) {
    Need ($script:Token -and $script:C.provider -eq 'github') 'GITHUB_TOKEN_REQUIRED_FOR_UPLOAD'
    Need ($script:State.next_poll -le (Epoch)) 'CHANNEL_COOLDOWN'
    $info=[IO.FileInfo]::new([IO.Path]::GetFullPath($Path))
    Need ($info.Exists -and $info.Length -gt 0 -and $info.Length -lt 5242880 -and $info.Extension -ieq '.zip') 'INVALID_ZIP_FILE'
    $bytes=[IO.File]::ReadAllBytes($info.FullName); $sha=Get-Sha256 $bytes
    Add-Type -AssemblyName System.IO.Compression
    try { $mem=[IO.MemoryStream]::new($bytes,$false); $zip=[IO.Compression.ZipArchive]::new($mem,[IO.Compression.ZipArchiveMode]::Read); $zip.Dispose(); $mem.Dispose() } catch { Fail 'INVALID_ZIP_FILE' }
    $uploadKey=$sha; $identity=$null
    $name='aiconnector-'+$script:C.namespace+'-'+$Node+'-'+$sha+'.zip'
    if ($script:Relay) {
        $identity=Identity-FromKey $Key; Assert-Relay
        if ($Node -eq 'windows-inner') { Need ($script:State.claims.ContainsKey($Key)) 'RESULT_UPLOAD_REQUIRES_CLAIM' }
        $role='input'; if ($Node -eq 'windows-inner') { $role='result' }
        if ($Diagnostics) {
            Need ($Node -ceq 'windows-inner' -and (Get-Field (Runs) $Key).phase -in @('result','receipt')) 'DIAGNOSTICS_REQUIRE_PUBLISHED_RESULT'
            $role='diagnostics'
        }
        $name=$role+'--'+$Node+'--'+$sha+'.zip'; $uploadKey='upload:'+$Key+':'+$sha
    }
    Need (-not $Diagnostics -or $script:Relay) 'DIAGNOSTICS_REQUIRE_RELAY'
    if (-not $script:State.uploads.ContainsKey($uploadKey)) { $script:State.uploads[$uploadKey]=@{status='pending';bytes=$bytes.Length;name=$name;manifest=$null;http=0}; Save }
    $row=$script:State.uploads[$uploadKey]
    if ($row.status -eq 'confirmed') { return $row.manifest }
    $check=Get-Field $row 'recovery'
    if ($row.status -eq 'uncertain' -and $check -and (Epoch)-$check.last_absent_at -lt $script:C.poll_seconds) { Fail 'UPLOAD_RECONCILE_PENDING' }
    if ($script:Relay) {
        $release=Ensure-RunRelease $identity; Need ($null -ne $release) 'RELEASE_NOT_CONFIRMED'
    } else {
        $r=Api ('/repos/'+$script:C.repository+'/releases/tags/'+$script:C.release_tag); Require-Response $r
        Need ($r.json.id -and -not $r.json.draft) 'RELEASE_NOT_PUBLIC'; $release=$r.json
    }
    $upload=([string]$release.upload_url) -replace '\{.*$',''; $u=Assert-Url $upload; $api=Assert-Url $script:C.api_base
    Need (($u.Host -ceq 'uploads.github.com' -and $u.AbsolutePath -ceq ('/repos/'+$script:C.repository+'/releases/'+$release.id+'/assets')) -or ($api.IsLoopback -and $u.IsLoopback -and $api.Authority -ceq $u.Authority)) 'INVALID_UPLOAD_TARGET'
    Need ($row.name -ceq $name -and $row.bytes -eq $bytes.Length) 'UPLOAD_IDENTITY_CHANGED'
    $freshUpload=$false
    $found=Read-UploadAssets $release $row
    if ($found.Count -eq 0) {
        Observe-DeliveryAbsent $row; Save
        Need ($row.status -ne 'rejected') 'UPLOAD_REJECTED'
        Need ($row.status -in @('pending','rate_limited')) 'UPLOAD_RECONCILE_PENDING'
        if ($script:Relay) {
            $delay=[int]((Get-Field $script:State 'post_not_before' 0)-(Epoch))
            Need ($delay -le 60) 'WRITE_COOLDOWN'
            if ($delay -gt 0) { Fail 'WRITE_COOLDOWN' }
        }
        Start-DeliveryWrite $row
        $r=Invoke-WireHttp -Url ($upload+'?name='+[Uri]::EscapeDataString($name)) -Method POST -BinaryBody $bytes -BinaryContentType 'application/zip' -Headers @{Authorization=('Bearer '+$script:Token);Accept='application/vnd.github+json'} -Authenticated $true
        $row.http=$r.http
        $script:State.post_not_before=(Epoch)+$script:C.write_interval_seconds
        if (Limited $r) { $row.status='rate_limited'; $script:State.next_poll=Cooldown $r; Save; Fail 'RATE_LIMITED' }
        if ($r.http -eq 422) {
            # A previous in-flight upload can win after our absence read. Verify
            # that object rather than overwrite/delete it or trust the 422.
            Save; $found=Read-UploadAssets $release $row
            if ($found.Count -eq 0) { $row.status='rejected'; Save; Fail 'UPLOAD_REJECTED' }
            $asset=$found[0]
        } else {
            if ($r.http -ge 400 -and $r.http -lt 500) { $row.status='rejected'; Save; Fail 'UPLOAD_REJECTED' }
            Save; Require-Response $r
            $asset=$r.json; $freshUpload=$r.http -eq 201
        }
    } else { $asset=$found[0] }
    Need ($asset.state -ceq 'uploaded' -and $asset.size -eq $bytes.Length -and $asset.name -ceq $name) 'ASSET_CONFLICT'
    $manifestName='artifact.zip'; if ($script:Relay) { $manifestName=$name }
    $manifest=@{name=$manifestName;bytes=$bytes.Length;sha256=$sha;url=[string]$asset.browser_download_url}
    if ($script:Relay) { Need ($manifest.url -ceq ($script:C.artifact_prefixes[0]+(Run-Tag $identity)+'/'+$name)) 'ARTIFACT_RUN_MISMATCH' }
    Artifact-Valid $manifest
    # Only a fresh result POST may leave public validation to the receiving Mac.
    # An ambiguous response, 422, or existing asset still requires byte equality.
    $digest=[string](Get-Field $asset 'digest')
    Need (-not $digest -or $digest -ceq ('sha256:'+$sha)) 'ARTIFACT_HASH_MISMATCH'
    $deferred=$script:DeferUploadVerification -and $script:Relay -and $Node -ceq 'windows-inner' -and $freshUpload -and -not $Diagnostics
    Trace-Event 'upload_api_confirmed' @{bytes=$bytes.Length}
    if (-not $deferred) { $null=Fetch-Artifacts @($manifest) $true }
    $row.public_verification='sender_verified'; if ($deferred) { $row.public_verification='receiver_required' }
    $row.status='confirmed'; $row.manifest=$manifest; $row.confirmed_at=Epoch
    $kind='upload_verified'; if ($deferred) { $kind='upload_verification_deferred' }
    Trace-Event $kind @{bytes=$bytes.Length;confirmed_at=$row.confirmed_at}; Save
    return $manifest
}
function Local-Action {
    if ($Action -eq 'Audit') { Audit-OneRoute; return Snapshot }
    if ($Action -eq 'Flush') { Auto-Transitions; Flush-Batch; return Snapshot }
    if ($Action -eq 'Advertise') { return Advertise-Capabilities }
    if ($Action -eq 'Capabilities') { Assert-Relay; $null=Read-Routes; return @{receiver_capabilities=(Read-Capabilities)} }
    if ($Action -eq 'Status') { return Snapshot }
    $runs=Runs
    if ($Action -eq 'Submit') {
        Need ($Node -eq 'mac-outer' -and $File) 'SUBMIT_REQUIRES_COORDINATOR_AND_FILE'
        $data=Read-Json $File; $identity=@{task_id=$data.task_id;revision=$data.revision;run_id=$data.run_id}
        foreach ($k in @('task_id','revision','run_id')) { $data.Remove($k) }
        $e=New-Event $identity 'task' '' $data; $key=Run-Key $e
        foreach ($other in @($script:State.events.Values)+@($script:State.outbox.Values | ForEach-Object { $_.event })) {
            if ($other.kind -ne 'task') { continue }
            if ((Run-Key $other) -ceq $key) { Need ($other.event_id -ceq $e.event_id) 'RUN_IS_IMMUTABLE' }
            elseif ($other.task_id -ceq $e.task_id -and $other.revision -eq $e.revision) { Need ((Revision-Digest $other) -ceq (Revision-Digest $e)) 'REVISION_IS_IMMUTABLE' }
        }
        Queue $e; return @{ok=$true;key=$key;event_id=$e.event_id;state='queued'}
    }
    if ($Action -in @('Upload','UploadDiagnostics')) { return In-Scope ('upload:'+$Key) { Upload-Zip $File ($Action -ceq 'UploadDiagnostics') } }
    if ($Action -eq 'RetryRejected') {
        $row=$null
        if ($script:State.outbox.ContainsKey($Key)) { $row=$script:State.outbox[$Key] }
        elseif ($script:State.uploads.ContainsKey($Key)) { $row=$script:State.uploads[$Key] }
        elseif ($script:State.provisions.ContainsKey($Key)) { $row=$script:State.provisions[$Key] }
        Need ($null -ne $row -and $row.status -eq 'rejected') 'ONLY_REJECTED_WRITES_CAN_BE_REQUEUED'
        $row.status='pending'; Save
        return @{ok=$true;key=$Key;state='pending'}
    }
    Need ($Node -eq 'windows-inner' -and $runs.ContainsKey($Key)) 'UNKNOWN_WORKER_RUN'
    $run=$runs[$Key]; Need ($run.phase -ne 'conflict') 'RUN_CONFLICT'
    if ($Action -eq 'Claim') {
        if ($script:State.claims.ContainsKey($Key)) {
            $claim=$script:State.claims[$Key]
            # Replay only the original supervisor's durable handoff. An owner
            # is private local state, never inferred from a public started event.
            if ($ClaimOwner -and (Get-Field $claim 'owner') -ceq $ClaimOwner -and
                $claim.status -ceq 'claimed' -and $run.phase -in @('accepted','started') -and -not $run.error) {
                $null=Fetch-Artifacts $run.task.artifacts
                return @{ok=$true;key=$Key;execute=$true;task=$run.task;claim_event_id=$claim.event_id;claim_owner=$ClaimOwner;replayed=$true}
            }
            return @{ok=$true;key=$Key;execute=$false;reason='ALREADY_CLAIMED'}
        }
        Need ($run.phase -eq 'accepted') 'RUN_NOT_READY'
        $null=Fetch-Artifacts $run.task.artifacts
        $e=New-Event $run.events.task 'started' $run.events.accepted.event_id @{status='started'}
        $script:State.claims[$Key]=@{event_id=$e.event_id;status='claimed';claimed_at=(Epoch);owner=$ClaimOwner}
        # Claim and outbox are committed together, before execution permission is returned.
        Queue $e; $null=Snapshot
        return @{ok=$true;key=$Key;execute=$true;task=$run.task;claim_event_id=$e.event_id;claim_owner=$ClaimOwner;replayed=$false}
    }
    Need ($Action -eq 'Complete' -and $File -and $script:State.claims.ContainsKey($Key)) 'RESULT_REQUIRES_LOCAL_CLAIM'
    $claim=$script:State.claims[$Key]
    $e=New-Event $run.events.task 'result' $claim.event_id (Read-Json $File)
    if ($claim.status -eq 'completed') { Need ($claim.result_id -ceq $e.event_id) 'RESULT_IS_IMMUTABLE' }
    $claim.status='completed'; $claim.result_id=$e.event_id; Queue $e; $null=Snapshot
    return @{ok=$true;key=$Key;event_id=$e.event_id;state='queued'}
}
function Serve-Requests {
    $script:Resident=$true
    Start-Profiling
    try { if ($script:Profiler) { $script:Profiler.Begin('startup','Startup','') } } catch { }
    Open-State
    try { if ($script:Profiler) { $script:Profiler.End() } } catch { }
    [Console]::WriteLine((Json @{schema='aiconnector.transport.v1';ready=$true}))
    while ($null -ne ($line=[Console]::ReadLine())) {
        $requestId=''; $watch=[Diagnostics.Stopwatch]::StartNew()
        try {
            Need ($script:Utf8.GetByteCount($line) -le 65536) 'TRANSPORT_REQUEST_TOO_LARGE'
            $request=Parse $line; $requestId=[string]$request.operation_id
            Need ($requestId -cmatch '^[a-zA-Z0-9_-]{1,96}$') 'INVALID_OPERATION_ID'
            $script:OperationId=$requestId
            Need ($request.action -cin @('Submit','Poll','Audit','Flush','Status','Claim','Complete','Upload','UploadDiagnostics','RetryRejected','Advertise','Capabilities')) 'INVALID_TRANSPORT_ACTION'
            $script:Action=[string]$request.action; $script:OperationId=$requestId
            $script:Key=[string]$request.key; $script:File=[string]$request.file; $script:ClaimOwner=[string]$request.claim_owner
            Need ($script:Key.Length -le 300 -and $script:File.Length -le 4096 -and $script:ClaimOwner -cmatch '^(|[a-f0-9]{48})$') 'INVALID_TRANSPORT_ARGUMENT'
            $script:Token=[string]$request.token; $script:IoScope='action:'+$Action+':'+$Key
            $credential=Hash $script:Token
            if ($script:MetadataCredential -cne $credential) { $script:MetadataCache.Clear(); $script:MetadataCredential=$credential }
            $script:WireDiagnostic=$null; $script:DeferUploadVerification=$true
            try { if ($script:Profiler) { $script:Profiler.Begin($OperationId,$Action,$Key) } } catch { }
            Trace-Event 'action_started'
            if ($Action -eq 'Poll') { $value=Poll-Once } else { $value=Local-Action }
            $replyStage=Start-Stage 'reply.serialize'
            try { $reply=Json @{id=$requestId;ok=$true;value=$value} } finally { Stop-Stage $replyStage }
            $pipeStage=Start-Stage 'reply.pipe'
            try { [Console]::WriteLine($reply) } finally { Stop-Stage $pipeStage }
        } catch {
            $script:MetadataCache.Clear()
            Trace-Fault $_ 'action'
            $code=Error-Code $_; $script:State.last_error=$code; Save
            $retry=Get-Field $script:State 'next_poll' 0
            if ($_.Exception.Data.Contains('retry_at')) { $retry=[Math]::Max($retry,[long]$_.Exception.Data['retry_at']) }
            if ($code -eq 'WRITE_COOLDOWN') { $retry=Get-Field $script:State 'post_not_before' 0 }
            [Console]::WriteLine((Json @{id=$requestId;ok=$false;error=@{ok=$false;code=$code;node=$Node;retry_at=$retry;line=$_.InvocationInfo.ScriptLineNumber;diagnostic=$script:WireDiagnostic}}))
        } finally { Trace-Event 'action_finished' @{elapsed_ms=[long]$watch.Elapsed.TotalMilliseconds}; $script:Token=''; try { if ($script:Profiler) { $script:Profiler.End() } } catch { } }
    }
    try { if ($script:Profiler) { $script:Profiler.Dispose(); $script:Profiler=$null } } catch { }
}
try {
    $script:C=Read-Json $Config
    Need ($script:C.schema -cin @('aiconnector.config.v1','aiconnector.config.v2') -and $script:C.provider -cin @('github','gitcode')) 'INVALID_CONFIG'
    $script:Relay=$script:C.schema -ceq 'aiconnector.config.v2'
    if ($defaultStateDir -and $script:Relay) { $StateDir=Join-Path (Join-Path $root 'connector-state-relay') $Node }
    Need ((Valid-Id $script:C.namespace) -and $script:C.repository -cmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') 'INVALID_CHANNEL'
    if ($script:Relay) { Need ($script:C.provider -ceq 'github' -and $script:C.layout -ceq 'task-issues-run-releases-v1') 'INVALID_RELAY_LAYOUT' }
    else { Need ([string]$script:C.issue -cmatch '^[1-9][0-9]*$') 'INVALID_CHANNEL' }
    $api=Assert-Url $script:C.api_base
    Need (-not $api.Query -and -not $api.Fragment) 'INVALID_API_URL'
    Need ($script:C.token_env -cmatch '^AICONNECTOR_[A-Z0-9_]+$') 'INVALID_TOKEN_ENV'
    if (-not $script:Relay) { Need ($script:C.release_tag -cmatch '^[A-Za-z0-9_.-]{1,64}$') 'INVALID_RELEASE_TAG' }
    if ($PollSeconds -gt 0) { $script:C.poll_seconds=$PollSeconds }
    Need ((Is-Integer $script:C.poll_seconds) -and $script:C.poll_seconds -ge 1 -and $script:C.poll_seconds -le 3600) 'INVALID_POLL_INTERVAL'
    Need ($api.IsLoopback -or $script:C.poll_seconds -ge 10) 'POLL_INTERVAL_TOO_SHORT'
    Need ((Is-Integer $script:C.max_pages) -and $script:C.max_pages -ge 1 -and $script:C.max_pages -le 100) 'INVALID_PAGE_LIMIT'
    Need ((Is-Integer $script:C.write_interval_seconds) -and $script:C.write_interval_seconds -ge 0 -and $script:C.write_interval_seconds -le 300) 'INVALID_WRITE_INTERVAL'
    foreach ($n in @('mac-outer','windows-inner')) { Need ($script:C.authors[$n] -is [Array] -and $script:C.authors[$n].Count -ge 1) 'MISSING_ALLOWED_AUTHORS' }
    Need ($script:C.artifact_prefixes -is [Array]) 'INVALID_ARTIFACT_PREFIXES'
    if ($script:Relay) {
        $expectedPrefix='https://github.com/'+$script:C.repository+'/releases/download/'
        Need ($script:C.artifact_prefixes.Count -eq 1 -and ($script:C.artifact_prefixes[0] -ceq $expectedPrefix -or ($api.IsLoopback -and $script:C.artifact_prefixes[0] -ceq ($script:C.api_base+'/assets/')))) 'INVALID_RELAY_ARTIFACT_PREFIX'
    }
    foreach ($prefix in $script:C.artifact_prefixes) { $u=Assert-Url $prefix; Need (-not $u.Query -and -not $u.Fragment -and $prefix.EndsWith('/')) 'INVALID_ARTIFACT_PREFIX' }
    $script:RepoPath='/repos/'+$script:C.repository
    $script:CommentsPath=$script:RepoPath+'/issues/'+$script:C.issue+'/comments'
    $script:Peer='mac-outer'; if ($Node -eq 'mac-outer') { $script:Peer='windows-inner' }
    $bindingData=@{node=$Node;namespace=$script:C.namespace;api=$script:C.api_base;provider=$script:C.provider;repository=$script:C.repository;issue=[string]$script:C.issue;authors=$script:C.authors;artifact_prefixes=$script:C.artifact_prefixes}
    if ($script:Relay) { $bindingData.layout=$script:C.layout }
    $script:Binding=Hash (Canonical $bindingData)
    $script:Token=[Environment]::GetEnvironmentVariable($script:C.token_env)
    if ($PromptToken -and -not $script:Token) { $secure=Read-Host '平台 Token（隐藏输入，回车只读）' -AsSecureString; $script:Token=(New-Object Net.NetworkCredential('', $secure)).Password }
    if ($Action -in @('Watch','Serve')) {
        [IO.Directory]::CreateDirectory($StateDir)|Out-Null
        try { $script:WatchLock=[IO.File]::Open((Join-Path $StateDir 'watch.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None) } catch { Fail 'WATCH_ALREADY_RUNNING' }
    }
    if ($Action -eq 'Serve') { Serve-Requests; return }
    $iteration=0
    do {
        try {
            Open-State
            if ($Action -in @('Poll','Watch')) { $value=Poll-Once } else { $value=Local-Action }
            [Console]::WriteLine((Json $value))
        } catch {
            $code=Error-Code $_
            if ($null -ne $script:State -and $null -ne $script:Lock) {
                $script:State.last_error=$code
                if (-not $script:Relay -and $Action -in @('Poll','Watch') -and $script:State.next_poll -le (Epoch)) { $script:State.next_poll=(Epoch)+60 }
                Save
            }
            if ($Action -ne 'Watch') { throw }
            [Console]::WriteLine((Json @{ok=$false;code=$code;node=$Node;line=$_.InvocationInfo.ScriptLineNumber;diagnostic=$script:WireDiagnostic}))
        } finally { Close-State }
        $iteration++
        if ($Action -ne 'Watch' -or ($Cycles -gt 0 -and $iteration -ge $Cycles)) { break }
        $wait=$script:C.poll_seconds+(Get-Random -Minimum 0 -Maximum ([Math]::Max(1,[int]($script:C.poll_seconds/10))))
        Start-Sleep -Seconds $wait
    } while ($true)
} catch {
    $code=Error-Code $_
    $retry=Get-Field $script:State 'next_poll' 0
    if ($_.Exception.Data.Contains('retry_at')) { $retry=[Math]::Max($retry,[long]$_.Exception.Data['retry_at']) }
    if ($code -eq 'WRITE_COOLDOWN') { $retry=Get-Field $script:State 'post_not_before' 0 }
    [Console]::WriteLine((Json @{ok=$false;code=$code;node=$Node;retry_at=$retry;line=$_.InvocationInfo.ScriptLineNumber;diagnostic=$script:WireDiagnostic}))
    exit 1
} finally { Close-State; if ($null -ne $script:WatchLock) { $script:WatchLock.Dispose() }; if ($null -ne $script:HttpClient) { $script:HttpClient.Dispose() }; $script:Token='' }
