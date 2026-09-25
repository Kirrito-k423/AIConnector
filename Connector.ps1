#requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateSet('Submit','Poll','Watch','Status','Claim','Complete','Upload','RetryRejected')][string]$Action='Status',
    [ValidateSet('mac-outer','windows-inner')][string]$Node='windows-inner',
    [string]$Config='', [string]$StateDir='', [string]$File='', [string]$Key='',
    [string]$Proxy='system', [switch]$PromptToken,
    [ValidateRange(1,120)][int]$TimeoutSeconds=30,
    [ValidateRange(0,100000)][int]$Cycles=0
)
$ErrorActionPreference='Stop'
$script:Utf8=New-Object Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Net.Http
$root=[IO.Path]::GetDirectoryName($PSCommandPath)
if (-not $Config) { $Config=Join-Path $root 'connector.config.json' }
if (-not $StateDir) { $StateDir=Join-Path (Join-Path $root 'connector-state') $Node }
$StateDir=[IO.Path]::GetFullPath($StateDir)
$script:Token=''; $script:State=$null; $script:Lock=$null; $script:WatchLock=$null
function Fail([string]$Code) { $e=New-Object InvalidOperationException('Connector stopped'); $e.Data['connector_code']=$Code; throw $e }
function Need($Condition,[string]$Code) { if (-not $Condition) { Fail $Code } }
function Get-Field($O,[string]$K,$Default=$null) {
    if ($null -eq $O) { return $Default }
    if ($O -is [Collections.IDictionary]) { if ($O.Contains($K)) { return ,$O[$K] }; return $Default }
    if ($null -ne $O.PSObject.Properties[$K]) { return ,$O.$K }; return $Default
}
function As-Map($O) {
    if ($null -eq $O) { return $null }
    if ($O -is [Collections.IDictionary] -or $O -is [pscustomobject]) {
        $m=@{}; $keys=$O.Keys; if ($O -is [pscustomobject]) { $keys=@($O.PSObject.Properties | ForEach-Object { $_.Name }) }
        foreach ($k in $keys) { $m[$k]=As-Map (Get-Field $O $k) }; return $m
    }
    if ($O -is [Array]) { $a=@(); foreach ($v in $O) { $a+=,(As-Map $v) }; return ,$a }
    return $O
}
function Json($O) { return ConvertTo-Json -InputObject $O -Depth 50 -Compress }
function Canonical($O) {
    if ($null -eq $O) { return 'null' }
    if ($O -is [Collections.IDictionary] -or $O -is [pscustomobject]) {
        [string[]]$keys=@($O.Keys); if ($O -is [pscustomobject]) { $keys=@($O.PSObject.Properties | ForEach-Object { $_.Name }) }
        [Array]::Sort($keys,[StringComparer]::Ordinal); $parts=@()
        foreach ($k in $keys) { $parts+=((Json $k)+':'+(Canonical (Get-Field $O $k))) }
        return '{'+($parts -join ',')+'}'
    }
    if ($O -is [Array]) { $parts=@(); foreach ($v in $O) { $parts+=,(Canonical $v) }; return '['+($parts -join ',')+']' }
    return Json $O
}
function Get-Sha256([byte[]]$Bytes) { $h=[Security.Cryptography.SHA256]::Create(); try { return ([BitConverter]::ToString($h.ComputeHash($Bytes))).Replace('-','').ToLowerInvariant() } finally { $h.Dispose() } }
function Hash([string]$Text) { return Get-Sha256 ($script:Utf8.GetBytes($Text)) }
function Parse([string]$Text) { return As-Map (ConvertFrom-Json -InputObject $Text) }
function Read-Json([string]$Path) { Need ([IO.FileInfo]::new($Path).Length -le 16777216) 'FILE_TOO_LARGE'; return Parse ([IO.File]::ReadAllText($Path,$script:Utf8)) }
function Epoch { return [long]([DateTimeOffset]::UtcNow.ToUnixTimeSeconds()) }
function Atomic([string]$Path,[string]$Text) {
    $tmp=$Path+'.'+[Guid]::NewGuid().ToString('N')+'.tmp'; $data=$script:Utf8.GetBytes($Text)
    try {
        $stream=[IO.File]::Open($tmp,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try { $stream.Write($data,0,$data.Length); $stream.Flush($true) } finally { $stream.Dispose() }
        if ([IO.File]::Exists($Path)) { [IO.File]::Replace($tmp,$Path,[NullString]::Value) } else { [IO.File]::Move($tmp,$Path) }
    } finally { if ([IO.File]::Exists($tmp)) { [IO.File]::Delete($tmp) } }
}
function Save {
    $body=Canonical $script:State
    $serialized=Json @{schema='aiconnector.store.v1';sha256=(Hash $body);data_base64=[Convert]::ToBase64String($script:Utf8.GetBytes($body))}
    Need ($script:Utf8.GetByteCount($serialized) -le 16777216) 'STATE_CAPACITY_REACHED'
    Atomic (Join-Path $StateDir 'state.json') $serialized
}
function Open-State {
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
        } catch { if ($_.Exception.Data['connector_code']) { throw }; Fail 'STATE_CORRUPT' }
    } else {
        $script:State=@{binding=$script:Binding;events=@{};comments=@{};outbox=@{};claims=@{};uploads=@{};conflicts=@{};ignored=@{};artifact_errors=@{};next_poll=0L;failures=0;last_error='';last_poll=0L}
        Save
    }
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
    $u = Assert-Url $Url
    if ($Authenticated -and $u.Scheme -ne 'https' -and -not $u.IsLoopback) {
        Fail '带凭据的请求必须使用 HTTPS。'
    }
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
    $client = New-Object System.Net.Http.HttpClient($handler)
    $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSeconds)
    $cts = New-Object Threading.CancellationTokenSource
    $cts.CancelAfter($TimeoutSeconds * 1000)
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $result = [ordered]@{ status = 'NETWORK_ERROR'; http = 0; elapsed_ms = 0; bytes = 0; url = (Get-SafeUrl $Url); content_type = ''; sha256 = ''; retry_after = ''; json = $null; data = $null; rate_remaining = ''; rate_reset = '' }
    $response = $null
    $req = $null
    try {
        for ($hop = 0; $hop -le 5; $hop++) {
            $req = New-Object System.Net.Http.HttpRequestMessage(([System.Net.Http.HttpMethod]::new($Method)), $u)
            $req.Headers.TryAddWithoutValidation('User-Agent', 'AIConnector/0.2') | Out-Null
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
        else { $result.status = 'NETWORK_ERROR' }
    } finally {
        $sw.Stop(); $result.elapsed_ms = $sw.ElapsedMilliseconds
        if ($null -ne $response) { $response.Dispose() }
        if ($null -ne $req) { $req.Dispose() }
        $cts.Dispose(); $client.Dispose()
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
    $script:State.failures++; $script:State.last_error=$R.status+'_'+$R.http
    if (Limited $R) { $script:State.next_poll=Cooldown $R }
    else { $script:State.next_poll=(Epoch)+[Math]::Min(900,30*[Math]::Pow(2,[Math]::Min(5,$script:State.failures))) }
    Save; Fail $script:State.last_error
}
function Read-Comments {
    $all=@()
    for ($page=1;$page -le $script:C.max_pages;$page++) {
        $r=Api ($script:CommentsPath+'?per_page=100&page='+$page); Require-Response $r
        Need ($r.json -is [Array]) 'INVALID_COMMENT_LIST'
        $all+=@($r.json)
        if ($r.json.Count -lt 100) { return ,$all }
    }
    Fail 'PAGINATION_INCOMPLETE'
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
        $names=@{}; foreach ($a in $D.artifacts) { Artifact-Valid $a; Need (-not $names.ContainsKey($a.name)) 'DUPLICATE_ARTIFACT_NAME'; $names[$a.name]=$true }
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
    $unsigned=@{}; foreach ($k in $E.Keys) { if ($k -ne 'event_id') { $unsigned[$k]=$E[$k] } }
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
function Event-Body($E) {
    $labels=@{task='待接收';accepted='已接收';started='已领取执行';result='结果已回传';receipt='结果已校验'}
    $d=Payload $E; $summary=$d.title; if ($E.kind -eq 'result') { $summary=$d.summary }
    $summary=([string]$summary -replace '[\r\n`<>]',' '); if ($summary.Length -gt 240) { $summary=$summary.Substring(0,240) }
    $details=@()
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
    $body=Event-Body $E
    if ($script:State.outbox.ContainsKey($E.event_id)) { return }
    $script:State.outbox[$E.event_id]=@{event=$E;body=$body;status='pending';attempts=0;http=0}
    Save
}
function Import-Comments($Comments) {
    foreach ($c in $Comments) {
        $id=[string]$c.id; $body=[string]$c.body; $digest=Hash $body
        if ($script:State.comments.ContainsKey($id)) {
            $old=$script:State.comments[$id]
            if ($old.digest -cne $digest -or $old.author -cne [string]$c.user.login) { $script:State.conflicts[$old.key]='COMMENT_CHANGED' }
            continue
        }
        if (-not $body.StartsWith('AIConnector task v1')) { continue }
        try {
            Need ($body -match '(?s)\AAIConnector task v1\r?\n.*?```json\r?\n(.*?)\r?\n```\s*\z' -and $script:Utf8.GetByteCount($body) -le 32768) 'INVALID_FRAME'
            $e=Parse $Matches[1]; Validate-Event $e
            Need (@($script:C.authors[$e.sender]) -ccontains [string]$c.user.login) 'AUTHOR_NOT_ALLOWED'
            $key=Run-Key $e
            $script:State.events[$e.event_id]=$e
            $script:State.comments[$id]=@{digest=$digest;key=$key;event_id=$e.event_id;author=[string]$c.user.login}
        } catch { $script:State.ignored[$id]='INVALID_OR_UNTRUSTED_EVENT' }
    }
    foreach ($item in $script:State.outbox.Values) {
        if ($script:State.events.ContainsKey($item.event.event_id)) { $item.status='confirmed' }
    }
    Save
}
function Runs {
    $result=@{}
    foreach ($e in $script:State.events.Values) {
        $key=Run-Key $e
        if (-not $result.ContainsKey($key)) { $result[$key]=@{key=$key;phase='waiting_parent';events=@{};error=''} }
        $run=$result[$key]
        if ($run.events.ContainsKey($e.kind) -and $run.events[$e.kind].event_id -cne $e.event_id) { $script:State.conflicts[$key]='CONFLICTING_EVENT' }
        $run.events[$e.kind]=$e
    }
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
function Fetch-Artifacts($Artifacts) {
    $paths=@()
    foreach ($a in $Artifacts) {
        Artifact-Valid $a
        $cache=Join-Path $StateDir 'artifacts'; [IO.Directory]::CreateDirectory($cache)|Out-Null
        $path=Join-Path $cache ($a.sha256+'.zip'); $valid=$false
        if ([IO.File]::Exists($path)) { $bytes=[IO.File]::ReadAllBytes($path); $valid=($bytes.Length -eq $a.bytes -and (Get-Sha256 $bytes) -ceq $a.sha256) }
        if (-not $valid) {
            $r=Invoke-WireHttp -Url $a.url -Limit 5242879
            Require-Response $r
            Need ($r.bytes -eq $a.bytes -and $r.sha256 -ceq $a.sha256) 'ARTIFACT_HASH_MISMATCH'
            Write-Bytes $path $r.data
        }
        $paths+=@{name=$a.name;path=$path;sha256=$a.sha256;bytes=$a.bytes}
    }
    return ,$paths
}
function Auto-Transitions {
    $runs=Runs
    foreach ($run in $runs.Values) {
        $kind=''; $parent=$null; $artifacts=@()
        if ($Node -eq 'windows-inner' -and $run.phase -eq 'task') { $kind='accepted'; $parent=$run.events.task; $artifacts=$run.task.artifacts }
        if ($Node -eq 'mac-outer' -and $run.phase -eq 'result') { $kind='receipt'; $parent=$run.events.result; $artifacts=$run.result.artifacts }
        if (-not $kind) { continue }
        try {
            if ($kind -eq 'receipt' -and $run.result.outcome -eq 'succeeded') { Need ($run.result.actual_revision -ceq $run.task.code.revision) 'RESULT_REVISION_MISMATCH' }
            $null=Fetch-Artifacts $artifacts
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
function Flush-One {
    if ($script:State.next_poll -gt (Epoch)) { return }
    if ((Get-Field $script:State 'post_not_before' 0) -gt (Epoch)) { return }
    $runs=Runs
    foreach ($id in @($script:State.outbox.Keys | Sort-Object)) {
        $item=$script:State.outbox[$id]; $e=$item.event; $key=Run-Key $e
        if ($item.status -notin @('pending','rate_limited')) { continue }
        if ($script:State.conflicts.ContainsKey($key) -or ($runs.ContainsKey($key) -and $runs[$key].phase -eq 'conflict')) { continue }
        if ($e.parent -and -not $script:State.events.ContainsKey($e.parent)) { continue }
        if (-not $script:Token) { $script:State.last_error='TOKEN_REQUIRED'; Save; return }
        $item.status='uncertain'; $item.attempts++; Save
        $r=Api $script:CommentsPath 'POST' (Json @{body=$item.body})
        $item.http=$r.http
        $script:State.post_not_before=(Epoch)+$script:C.write_interval_seconds
        if (Limited $r) {
            $item.status='rate_limited'; $script:State.failures++; $script:State.next_poll=Cooldown $r; $script:State.last_error='RATE_LIMITED'
        } elseif ($r.http -ge 400 -and $r.http -lt 500) { $item.status='rejected'; $script:State.last_error='WRITE_REJECTED_'+$r.http }
        # A response alone never confirms a write. Reconcile through an independent full GET.
        Save
        if ($script:State.next_poll -le (Epoch)) { Import-Comments (Read-Comments) }
        return
    }
}
function Snapshot {
    $runs=Runs; $list=@(); $inbox=Join-Path $StateDir 'inbox'; [IO.Directory]::CreateDirectory($inbox)|Out-Null
    foreach ($run in @($runs.Values | Sort-Object key)) {
        $row=@{key=$run.key;phase=$run.phase;error=$run.error;task=(Get-Field $run 'task');result=(Get-Field $run 'result');claimed=$script:State.claims.ContainsKey($run.key);inbox_file=(Join-Path $inbox ((Hash $run.key)+'.json'))}
        $row.local_artifacts=@()
        foreach ($which in @('task','result')) {
            $d=Get-Field $run $which
            if ($d) { foreach ($a in $d.artifacts) { $row.local_artifacts+=@{name=$a.name;path=(Join-Path (Join-Path $StateDir 'artifacts') ($a.sha256+'.zip'))} } }
        }
        Atomic $row.inbox_file (Json $row); $list+=,$row
    }
    $outbox=@(); foreach ($item in $script:State.outbox.Values) { $outbox+=@{event_id=$item.event.event_id;key=(Run-Key $item.event);kind=$item.event.kind;status=$item.status;attempts=$item.attempts;http=$item.http} }
    $snapshot=@{schema='aiconnector.status.v1';node=$Node;runs=$list;outbox=$outbox;next_poll=$script:State.next_poll;last_poll=$script:State.last_poll;last_error=$script:State.last_error;ignored_comments=$script:State.ignored.Count}
    Atomic (Join-Path $StateDir 'status.json') (Json $snapshot)
    $lines=@('# AIConnector '+$Node,'','| 运行 | 状态 | 本地已领取 | 异常 |','|---|---|---|---|')
    foreach ($r in $list) { $lines+='| '+$r.key+' | '+$r.phase+' | '+$r.claimed+' | '+$r.error+' |' }
    $pending=@($outbox | Where-Object { $_.status -ne 'confirmed' })
    $lines+=@('','未确认消息：'+$pending.Count,'最后通道异常：'+$script:State.last_error,'','回执只确认结果和产物完整收到；实验结论由 AI 或人评估。')
    Atomic (Join-Path $StateDir 'status.md') ($lines -join "`n")
    Save; return $snapshot
}
function Poll-Once {
    if ($script:State.next_poll -gt (Epoch)) { return Snapshot }
    Import-Comments (Read-Comments)
    $script:State.last_poll=Epoch; $script:State.last_error=''; $script:State.next_poll=0L
    Auto-Transitions; Flush-One
    if (-not $script:State.last_error) { $script:State.failures=0 }
    return Snapshot
}
function Upload-Zip([string]$Path) {
    Need ($script:Token -and $script:C.provider -eq 'github') 'GITHUB_TOKEN_REQUIRED_FOR_UPLOAD'
    Need ($script:State.next_poll -le (Epoch)) 'CHANNEL_COOLDOWN'
    $info=[IO.FileInfo]::new([IO.Path]::GetFullPath($Path))
    Need ($info.Exists -and $info.Length -gt 0 -and $info.Length -lt 5242880 -and $info.Extension -ieq '.zip') 'INVALID_ZIP_FILE'
    $bytes=[IO.File]::ReadAllBytes($info.FullName); $sha=Get-Sha256 $bytes
    Add-Type -AssemblyName System.IO.Compression
    try { $mem=[IO.MemoryStream]::new($bytes,$false); $zip=[IO.Compression.ZipArchive]::new($mem,[IO.Compression.ZipArchiveMode]::Read); $zip.Dispose(); $mem.Dispose() } catch { Fail 'INVALID_ZIP_FILE' }
    $name='aiconnector-'+$script:C.namespace+'-'+$Node+'-'+$sha+'.zip'
    if (-not $script:State.uploads.ContainsKey($sha)) { $script:State.uploads[$sha]=@{status='pending';bytes=$bytes.Length;name=$name;manifest=$null;http=0}; Save }
    $row=$script:State.uploads[$sha]
    if ($row.status -eq 'confirmed') { return $row.manifest }
    $r=Api ('/repos/'+$script:C.repository+'/releases/tags/'+$script:C.release_tag); Require-Response $r
    Need ($r.json.id -and -not $r.json.draft) 'RELEASE_NOT_PUBLIC'
    $release=$r.json; $upload=([string]$release.upload_url) -replace '\{.*$',''; $u=Assert-Url $upload; $api=Assert-Url $script:C.api_base
    Need (($u.Host -ceq 'uploads.github.com' -and $u.AbsolutePath -ceq ('/repos/'+$script:C.repository+'/releases/'+$release.id+'/assets')) -or ($api.IsLoopback -and $u.IsLoopback -and $api.Authority -ceq $u.Authority)) 'INVALID_UPLOAD_TARGET'
    $assets=@(); $complete=$false
    for ($page=1;$page -le $script:C.max_pages;$page++) {
        $r=Api ('/repos/'+$script:C.repository+'/releases/'+$release.id+'/assets?per_page=100&page='+$page); Require-Response $r
        Need ($r.json -is [Array]) 'INVALID_ASSET_LIST'; $assets+=@($r.json)
        if ($r.json.Count -lt 100) { $complete=$true; break }
    }
    Need $complete 'PAGINATION_INCOMPLETE'
    $found=@($assets | Where-Object { $_.name -ceq $name })
    Need ($found.Count -le 1) 'ASSET_CONFLICT'
    if ($found.Count -eq 0) {
        Need ($row.status -in @('pending','rate_limited')) 'UPLOAD_UNCERTAIN_NO_RETRY'
        $row.status='uncertain'; Save
        $r=Invoke-WireHttp -Url ($upload+'?name='+[Uri]::EscapeDataString($name)) -Method POST -BinaryBody $bytes -BinaryContentType 'application/zip' -Headers @{Authorization=('Bearer '+$script:Token);Accept='application/vnd.github+json'} -Authenticated $true
        $row.http=$r.http
        if (Limited $r) { $row.status='rate_limited'; $script:State.next_poll=Cooldown $r; Save; Fail 'RATE_LIMITED' }
        if ($r.http -ge 400 -and $r.http -lt 500) { $row.status='rejected'; Save; Fail 'UPLOAD_REJECTED' }
        Save; Require-Response $r
        $asset=$r.json
    } else { $asset=$found[0] }
    Need ($asset.state -ceq 'uploaded' -and $asset.size -eq $bytes.Length -and $asset.name -ceq $name) 'ASSET_CONFLICT'
    $manifest=@{name='artifact.zip';bytes=$bytes.Length;sha256=$sha;url=[string]$asset.browser_download_url}
    Artifact-Valid $manifest; $null=Fetch-Artifacts @($manifest)
    $row.status='confirmed'; $row.manifest=$manifest; Save
    return $manifest
}
function Local-Action {
    $runs=Runs
    if ($Action -eq 'Submit') {
        Need ($Node -eq 'mac-outer' -and $File) 'SUBMIT_REQUIRES_COORDINATOR_AND_FILE'
        $data=Read-Json $File; $identity=@{task_id=$data.task_id;revision=$data.revision;run_id=$data.run_id}
        foreach ($k in @('task_id','revision','run_id')) { $data.Remove($k) }
        $e=New-Event $identity 'task' '' $data; $key=Run-Key $e
        foreach ($other in @($script:State.events.Values)+@($script:State.outbox.Values | ForEach-Object { $_.event })) {
            if ((Run-Key $other) -ceq $key -and $other.kind -eq 'task') { Need ($other.event_id -ceq $e.event_id) 'RUN_IS_IMMUTABLE' }
        }
        Queue $e; return @{ok=$true;key=$key;event_id=$e.event_id;state='queued'}
    }
    if ($Action -eq 'Upload') { return Upload-Zip $File }
    if ($Action -eq 'RetryRejected') {
        Need ($Key -cmatch '^[a-f0-9]{64}$') 'MESSAGE_OR_ARTIFACT_HASH_REQUIRED'
        $row=$null
        if ($script:State.outbox.ContainsKey($Key)) { $row=$script:State.outbox[$Key] }
        elseif ($script:State.uploads.ContainsKey($Key)) { $row=$script:State.uploads[$Key] }
        Need ($null -ne $row -and $row.status -eq 'rejected') 'ONLY_REJECTED_WRITES_CAN_BE_REQUEUED'
        $row.status='pending'; Save
        return @{ok=$true;key=$Key;state='pending'}
    }
    if ($Action -eq 'Status') { return Snapshot }
    Need ($Node -eq 'windows-inner' -and $runs.ContainsKey($Key)) 'UNKNOWN_WORKER_RUN'
    $run=$runs[$Key]; Need ($run.phase -ne 'conflict') 'RUN_CONFLICT'
    if ($Action -eq 'Claim') {
        if ($script:State.claims.ContainsKey($Key)) { return @{ok=$true;key=$Key;execute=$false;reason='ALREADY_CLAIMED'} }
        Need ($run.phase -eq 'accepted') 'RUN_NOT_READY'
        $null=Fetch-Artifacts $run.task.artifacts
        $e=New-Event $run.events.task 'started' $run.events.accepted.event_id @{status='started'}
        $script:State.claims[$Key]=@{event_id=$e.event_id;status='claimed';claimed_at=(Epoch)}
        # Claim and outbox are committed together, before execution permission is returned.
        Queue $e; $null=Snapshot
        return @{ok=$true;key=$Key;execute=$true;task=$run.task;claim_event_id=$e.event_id}
    }
    Need ($Action -eq 'Complete' -and $File -and $script:State.claims.ContainsKey($Key)) 'RESULT_REQUIRES_LOCAL_CLAIM'
    $claim=$script:State.claims[$Key]
    $e=New-Event $run.events.task 'result' $claim.event_id (Read-Json $File)
    if ($claim.status -eq 'completed') { Need ($claim.result_id -ceq $e.event_id) 'RESULT_IS_IMMUTABLE' }
    $claim.status='completed'; $claim.result_id=$e.event_id; Queue $e; $null=Snapshot
    return @{ok=$true;key=$Key;event_id=$e.event_id;state='queued'}
}
try {
    $script:C=Read-Json $Config
    Need ($script:C.schema -ceq 'aiconnector.config.v1' -and $script:C.provider -cin @('github','gitcode')) 'INVALID_CONFIG'
    Need ((Valid-Id $script:C.namespace) -and $script:C.repository -cmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -and [string]$script:C.issue -cmatch '^[1-9][0-9]*$') 'INVALID_CHANNEL'
    $api=Assert-Url $script:C.api_base
    Need (-not $api.Query -and -not $api.Fragment) 'INVALID_API_URL'
    Need ($script:C.token_env -cmatch '^AICONNECTOR_[A-Z0-9_]+$') 'INVALID_TOKEN_ENV'
    Need ($script:C.release_tag -cmatch '^[A-Za-z0-9_.-]{1,64}$') 'INVALID_RELEASE_TAG'
    Need ((Is-Integer $script:C.poll_seconds) -and $script:C.poll_seconds -ge 1 -and $script:C.poll_seconds -le 3600) 'INVALID_POLL_INTERVAL'
    Need ($api.IsLoopback -or $script:C.poll_seconds -ge 15) 'POLL_INTERVAL_TOO_SHORT'
    Need ((Is-Integer $script:C.max_pages) -and $script:C.max_pages -ge 1 -and $script:C.max_pages -le 100) 'INVALID_PAGE_LIMIT'
    Need ((Is-Integer $script:C.write_interval_seconds) -and $script:C.write_interval_seconds -ge 0 -and $script:C.write_interval_seconds -le 300) 'INVALID_WRITE_INTERVAL'
    foreach ($n in @('mac-outer','windows-inner')) { Need ($script:C.authors[$n] -is [Array] -and $script:C.authors[$n].Count -ge 1) 'MISSING_ALLOWED_AUTHORS' }
    Need ($script:C.artifact_prefixes -is [Array]) 'INVALID_ARTIFACT_PREFIXES'
    foreach ($prefix in $script:C.artifact_prefixes) { $u=Assert-Url $prefix; Need (-not $u.Query -and -not $u.Fragment -and $prefix.EndsWith('/')) 'INVALID_ARTIFACT_PREFIX' }
    $script:CommentsPath='/repos/'+$script:C.repository+'/issues/'+$script:C.issue+'/comments'
    $script:Peer='mac-outer'; if ($Node -eq 'mac-outer') { $script:Peer='windows-inner' }
    $script:Binding=Hash (Canonical @{node=$Node;namespace=$script:C.namespace;api=$script:C.api_base;provider=$script:C.provider;repository=$script:C.repository;issue=[string]$script:C.issue;authors=$script:C.authors;artifact_prefixes=$script:C.artifact_prefixes})
    $script:Token=[Environment]::GetEnvironmentVariable($script:C.token_env)
    if ($PromptToken -and -not $script:Token) { $secure=Read-Host '平台 Token（隐藏输入，回车只读）' -AsSecureString; $script:Token=(New-Object Net.NetworkCredential('', $secure)).Password }
    if ($Action -eq 'Watch') {
        [IO.Directory]::CreateDirectory($StateDir)|Out-Null
        try { $script:WatchLock=[IO.File]::Open((Join-Path $StateDir 'watch.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None) } catch { Fail 'WATCH_ALREADY_RUNNING' }
    }
    $iteration=0
    do {
        try {
            Open-State
            if ($Action -in @('Poll','Watch')) { $value=Poll-Once } else { $value=Local-Action }
            [Console]::WriteLine((Json $value))
        } catch {
            $code=[string]$_.Exception.Data['connector_code']; if (-not $code) { $code='CONNECTOR_ERROR' }
            if ($null -ne $script:State -and $null -ne $script:Lock) {
                $script:State.last_error=$code
                if ($Action -in @('Poll','Watch') -and $script:State.next_poll -le (Epoch)) { $script:State.next_poll=(Epoch)+60 }
                Save
            }
            if ($Action -ne 'Watch') { throw }
            [Console]::WriteLine((Json @{ok=$false;code=$code;node=$Node}))
        } finally { Close-State }
        $iteration++
        if ($Action -ne 'Watch' -or ($Cycles -gt 0 -and $iteration -ge $Cycles)) { break }
        $wait=$script:C.poll_seconds+(Get-Random -Minimum 0 -Maximum ([Math]::Max(1,[int]($script:C.poll_seconds/10))))
        Start-Sleep -Seconds $wait
    } while ($true)
} catch {
    $code=[string]$_.Exception.Data['connector_code']; if (-not $code) { $code='CONNECTOR_ERROR' }
    [Console]::WriteLine((Json @{ok=$false;code=$code;node=$Node;line=$_.InvocationInfo.ScriptLineNumber}))
    exit 1
} finally { Close-State; if ($null -ne $script:WatchLock) { $script:WatchLock.Dispose() }; $script:Token='' }
