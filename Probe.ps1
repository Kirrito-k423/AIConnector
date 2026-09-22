#requires -Version 5.1
<##
AIConnector channel probe. Windows PowerShell 5.1 / PowerShell 7.
No external modules. Default Scan performs GET requests only.
##>
[CmdletBinding()]
param(
    [ValidateSet('Scan', 'Samples', 'Send', 'Receive', 'Verify')]
    [string]$Mode = 'Scan',
    [string]$Config = '',
    [ValidatePattern('^[A-Za-z0-9_-]{1,64}$')][string]$Node = 'local',
    [string]$Peer = '',
    [string]$Channel = 'gitcode',
    [string]$Session = '',
    [string]$Proxy = 'system',
    [string]$OutputDir = '',
    [ValidateRange(1, 60)][int]$TimeoutSeconds = 12,
    [ValidateRange(256, 32768)][int]$SizeBytes = 1024,
    [ValidateRange(1, 100)][int]$MaxPages = 10,
    [switch]$PromptToken
)

$ErrorActionPreference = 'Stop'
# Windows PowerShell can evaluate parameter defaults before PSScriptRoot is
# populated. Resolve file-relative defaults only after parameter binding.
$scriptFile = $PSCommandPath
if (-not $scriptFile) { $scriptFile = $MyInvocation.MyCommand.Path }
$scriptRoot = [IO.Path]::GetDirectoryName($scriptFile)
if (-not $scriptRoot) { throw '无法定位脚本目录，请将 Probe.ps1 保存为文件后运行。' }
if (-not $Config) { $Config = Join-Path $scriptRoot 'probe.config.json' }
if (-not $OutputDir) { $OutputDir = Join-Path $scriptRoot 'reports' }
Add-Type -AssemblyName System.Net.Http
$script:Utf8 = New-Object System.Text.UTF8Encoding($false)
$script:Token = ''
$script:Results = New-Object System.Collections.Generic.List[object]
$script:DownloadLimit = 16 * 1024 * 1024
$script:Report = [ordered]@{
    schema = 'aiconnector.report.v1'; node = $Node; mode = $Mode
    generated_at = [DateTime]::UtcNow.ToString('o')
    platform = [Environment]::OSVersion.Platform.ToString()
    powershell = $PSVersionTable.PSVersion.ToString()
    route = $(if ($Proxy -in @('system','direct')) { $Proxy } else { 'explicit_proxy' })
    observations = $script:Results
    limits = @(
        '本报告只证明本次、此机器、此访问方式的观测结果。',
        'HTTP 可达不等于浏览器登录可用；单端成功不等于跨机器成功。',
        '未测试的上传类型和容量上限均为未知。'
    )
}

function Get-Field($Object, [string]$Name, $Default = '') {
    if ($null -eq $Object) { return $Default }
    $p = $Object.PSObject.Properties[$Name]
    if ($null -eq $p -or $null -eq $p.Value) { return $Default }
    return $p.Value
}
function Get-Sha256([byte[]]$Bytes) {
    $h = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($h.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
    finally { $h.Dispose() }
}
function Get-TextHash([string]$Text) { return Get-Sha256 ($script:Utf8.GetBytes($Text)) }
function Stop-Probe([string]$Reason) {
    $exception = New-Object InvalidOperationException('AIConnector probe stopped')
    $exception.Data['probe_reason'] = $Reason
    throw $exception
}
function Get-SafeUrl([string]$Url) {
    try {
        $u = [Uri]$Url
        # Query strings may contain access tokens or signed download credentials.
        return $u.GetLeftPart([UriPartial]::Path)
    } catch { return '(invalid URL)' }
}
function Assert-Url([string]$Url) {
    $u = [Uri]$Url
    if (-not $u.IsAbsoluteUri -or $u.Scheme -notin @('http','https') -or $u.UserInfo) {
        Stop-Probe 'URL 必须为不含用户名密码的 HTTP(S) 地址。'
    }
    return $u
}
function Add-Observation([string]$Test, [string]$Status, [string]$Detail, $Evidence = $null) {
    $row = [ordered]@{ test = $Test; status = $Status; detail = $Detail }
    if ($null -ne $Evidence) { $row.evidence = $Evidence }
    $script:Results.Add([pscustomobject]$row)
    Write-Host ('[{0}] {1}: {2}' -f $Status, $Test, $Detail)
}
function Save-Report {
    [IO.Directory]::CreateDirectory($OutputDir) | Out-Null
    $stem = '{0}-{1}-{2}-{3}' -f $Node, $Mode.ToLowerInvariant(), [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss'), ([Guid]::NewGuid().ToString('N').Substring(0,6))
    $jsonPath = Join-Path $OutputDir ($stem + '.json')
    $mdPath = Join-Path $OutputDir ($stem + '.md')
    [IO.File]::WriteAllText($jsonPath, ($script:Report | ConvertTo-Json -Depth 20), $script:Utf8)
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add('# AIConnector 通道探测报告')
    $lines.Add('')
    $lines.Add(('节点：{0}；模式：{1}；路由：{2}；PowerShell：{3}' -f $Node,$Mode,$script:Report.route,$script:Report.powershell))
    $lines.Add(('时间：{0}' -f $script:Report.generated_at))
    $lines.Add('')
    $lines.Add('| 检查 | 状态 | 说明 |')
    $lines.Add('|---|---|---|')
    foreach ($r in $script:Results) {
        $lines.Add(('| {0} | {1} | {2} |' -f ($r.test -replace '[|\r\n]',' '),$r.status,($r.detail -replace '[|\r\n]',' ')))
    }
    $lines.Add('')
    foreach ($line in $script:Report.limits) { $lines.Add('- ' + $line) }
    [IO.File]::WriteAllText($mdPath, ($lines -join "`n"), $script:Utf8)
    Write-Host ('报告：' + $mdPath)
}

function Invoke-ProbeHttp {
    param([string]$Url, [string]$Method = 'GET', [hashtable]$Headers = @{},
        [string]$Body = '', [int]$Limit = 2097152, [bool]$Authenticated = $false)
    $u = Assert-Url $Url
    if ($Authenticated -and $u.Scheme -ne 'https' -and -not $u.IsLoopback) {
        Stop-Probe '带凭据的请求必须使用 HTTPS。'
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
    $result = [ordered]@{ status = 'NETWORK_ERROR'; http = 0; elapsed_ms = 0; bytes = 0; url = (Get-SafeUrl $Url); content_type = ''; sha256 = ''; retry_after = ''; json = $null }
    $response = $null
    $req = $null
    try {
        for ($hop = 0; $hop -le 5; $hop++) {
            $req = New-Object System.Net.Http.HttpRequestMessage(([System.Net.Http.HttpMethod]::new($Method)), $u)
            $req.Headers.TryAddWithoutValidation('User-Agent', 'AIConnector-Probe/0.1') | Out-Null
            foreach ($key in $Headers.Keys) { $req.Headers.TryAddWithoutValidation($key, [string]$Headers[$key]) | Out-Null }
            if ($Method -eq 'POST') { $req.Content = New-Object System.Net.Http.StringContent($Body, $script:Utf8, 'application/json') }
            $response = $client.SendAsync($req, [Net.Http.HttpCompletionOption]::ResponseHeadersRead, $cts.Token).GetAwaiter().GetResult()
            $result.http = [int]$response.StatusCode
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
function Get-Evidence($Result) {
    return [ordered]@{ http = $Result.http; elapsed_ms = $Result.elapsed_ms; bytes = $Result.bytes
        url = $Result.url; content_type = $Result.content_type; sha256 = $Result.sha256; retry_after = $Result.retry_after }
}
function Get-Token($C) {
    $name = [string](Get-Field $C 'token_env')
    if (-not $name) { return '' }
    return [Environment]::GetEnvironmentVariable($name)
}
function Invoke-ChannelApi($C, [string]$Path, [string]$Method = 'GET', [string]$Body = '', [string]$Token = '') {
    $base = ([string]$C.api_base).TrimEnd('/')
    $url = $base + $Path
    $headers = @{ Accept = 'application/json' }
    if ($C.provider -eq 'github') {
        $headers.Accept = 'application/vnd.github+json'
        if ($Token) { $headers.Authorization = 'Bearer ' + $Token }
    } elseif ($C.provider -eq 'gitcode') {
        if ($Token) {
            $separator = '?'; if ($url.Contains('?')) { $separator = '&' }
            $url += $separator + 'access_token=' + [Uri]::EscapeDataString($Token)
        }
    } else { Stop-Probe 'provider 只支持 gitcode 或 github。' }
    return Invoke-ProbeHttp -Url $url -Method $Method -Headers $headers -Body $Body -Authenticated ([bool]$Token)
}
function Get-CommentsPath($C) {
    $repo = [string](Get-Field $C 'repository')
    $issue = [string](Get-Field $C 'issue')
    if ($repo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' -or $issue -notmatch '^[A-Za-z0-9_-]+$') {
        Stop-Probe '请先在配置中填写 repository（owner/repo）和专用测试 issue 编号。'
    }
    return '/repos/' + $repo + '/issues/' + $issue + '/comments'
}
function Get-Comments($C, [string]$Token) {
    $path = Get-CommentsPath $C
    $items = New-Object System.Collections.Generic.List[object]
    for ($page = 1; $page -le $MaxPages; $page++) {
        $r = Invoke-ChannelApi $C ($path + '?per_page=100&page=' + $page) 'GET' '' $Token
        if ($r.status -ne 'HTTP_OK' -or $null -eq $r.json -or $r.json -isnot [Array]) {
            Stop-Probe ('评论读取未通过：' + $r.status + '，HTTP ' + $r.http + '；应返回 JSON 数组。')
        }
        foreach ($item in $r.json) {
            if ($null -eq $item -or -not (Get-Field $item 'id') -or $null -eq $item.PSObject.Properties['body']) { Stop-Probe '评论响应结构不符合接口协议。' }
            $items.Add($item)
        }
        if ($r.json.Count -lt 100) { return ,($items.ToArray()) }
    }
    Stop-Probe '达到分页上限，不能证明已读取完整；请使用专用测试 Issue 或增加 MaxPages。'
}
function ConvertTo-PacketBody($Packet) {
    return 'AIConnector probe v1' + "`n`n" + '```json' + "`n" + ($Packet | ConvertTo-Json -Depth 8 -Compress) + "`n" + '```'
}
function Read-Packet([string]$Body) {
    if ($Body -match '(?s)\AAIConnector probe v1\r?\n\r?\n```json\r?\n(.+?)\r?\n```\s*\z') {
        try {
            $p = ConvertFrom-Json -InputObject $Matches[1]
            if ((Get-Field $p 'schema') -eq 'aiconnector.probe.v1') { return $p }
        } catch { }
    }
    return $null
}
function Publish-Packet($C, $Packet, $Comments, [string]$Token) {
    $body = ConvertTo-PacketBody $Packet
    foreach ($comment in $Comments) {
        $old = Read-Packet ([string]$comment.body)
        if ($null -ne $old -and (Get-Field $old 'message_id') -eq $Packet.message_id) {
            if ($comment.body -cne $body) { Stop-Probe '同一消息 ID 已存在但内容不同，请使用新的 Session。' }
            return [pscustomobject]@{ status = 'ALREADY_PRESENT'; comment_id = [string]$comment.id; body_bytes = $script:Utf8.GetByteCount($body) }
        }
    }
    $requestBody = @{body = $body} | ConvertTo-Json -Compress
    $r = Invoke-ChannelApi $C (Get-CommentsPath $C) 'POST' $requestBody $Token
    if ($r.status -ne 'HTTP_OK' -or -not (Get-Field $r.json 'id')) {
        Stop-Probe ('写入结果未确认：' + $r.status + '。不自动重发；用相同参数重试时会先读取已有消息。')
    }
    if ([string](Get-Field $r.json 'body') -cne $body) { Stop-Probe '服务端返回的评论正文与发送内容不一致。' }
    return [pscustomobject]@{ status = 'POST_ACCEPTED'; comment_id = [string]$r.json.id; body_bytes = $script:Utf8.GetByteCount($body) }
}

function Invoke-Scan($Settings) {
    foreach ($c in $Settings.channels) {
        $name = [string]$c.name
        Write-Host ('正在检查 ' + $name + ' ...')
        $web = Invoke-ProbeHttp -Url $c.website
        $status = $web.status
        if ($status -eq 'HTTP_OK') { $status = 'HTTP_REACHABLE_ONLY' }
        Add-Observation ($name + '/website') $status '仅检查脚本 HTTP 访问；浏览器登录、验证码与页面功能尚未验证。' (Get-Evidence $web)
        $token = Get-Token $c
        $api = Invoke-ChannelApi $c '/user' 'GET' '' $token
        $status = $api.status
        $detail = '检查身份 API；未保存响应正文。'
        if ($status -eq 'HTTP_OK') {
            if ((Get-Field $api.json 'id') -and (Get-Field $api.json 'login')) {
                $status = 'AUTH_API_VERIFIED'; $detail = '身份 API 返回预期字段；Issue 读写权限仍需单独测试。'
            } else { $status = 'UNEXPECTED_API_RESPONSE'; $detail = 'HTTP 成功但不符合身份 API 结构，可能是登录页或拦截页。' }
        } elseif ($api.http -eq 401) {
            if ($token) { $status = 'AUTH_REJECTED'; $detail = '已提供凭据但返回 401；检查凭据和服务端认证方式。' }
            else { $status = 'NEEDS_TOKEN'; $detail = '未提供 Token，收到 HTTP 401；凭据认证能力尚未验证。' }
        }
        Add-Observation ($name + '/api') $status $detail (Get-Evidence $api)
        if ((Get-Field $c 'repository') -and (Get-Field $c 'issue')) {
            try {
                $comments = Get-Comments $c $token
                Add-Observation ($name + '/issue_read') 'PASS' ('读取并验证了评论数组，条数：' + $comments.Count)
            } catch {
                Add-Observation ($name + '/issue_read') 'NOT_VERIFIED' '未能完成评论读取；检查 Issue、凭据、响应结构和分页限制。'
            }
        } else { Add-Observation ($name + '/issue_read') 'NOT_CONFIGURED' '尚未填写测试仓库与 Issue。' }
        Add-Observation ($name + '/upload_and_peer') 'NOT_TESTED' 'Scan 不写入；跨机器文本用 Send/Receive/Verify 测试，附件上传尚未验证。'
    }
    foreach ($d in @(Get-Field $Settings 'downloads' @())) {
        $r = Invoke-ProbeHttp -Url $d.url -Limit $script:DownloadLimit
        $expected = [string](Get-Field $d 'sha256')
        $status = $r.status
        $detail = '下载失败或未完成。'
        if ($status -eq 'HTTP_OK') {
            if (-not $expected) { $status = 'DOWNLOADED_UNVERIFIED'; $detail = '已获取响应；缺少原文件 SHA-256，无法排除登录页、转码或截断。' }
            elseif ($expected -notmatch '^[a-fA-F0-9]{64}$') { $status = 'INVALID_EXPECTED_HASH'; $detail = '配置中的 SHA-256 格式不正确。' }
            elseif ($expected.ToLowerInvariant() -eq $r.sha256) { $status = 'EXACT_BYTES_VERIFIED'; $detail = '下载字节与指定原文件 SHA-256 一致；只证明此文件、此大小。' }
            else { $status = 'HASH_MISMATCH'; $detail = '下载结果不等于原文件；可能被转码、截断或返回拦截页面。' }
        }
        Add-Observation ('download/' + $d.name) $status $detail (Get-Evidence $r)
    }
    if (@(Get-Field $Settings 'downloads' @()).Count -eq 0) {
        Add-Observation 'downloads' 'NOT_CONFIGURED' '可先运行 Samples 生成样本；手工上传后将下载地址与 SHA-256 写入配置。'
    }
}
function New-Samples {
    $dir = Join-Path $OutputDir 'samples'
    [IO.Directory]::CreateDirectory($dir) | Out-Null
    $manifest = New-Object System.Collections.Generic.List[object]
    $files = @{}
    foreach ($size in @(1024,8192,32768)) {
        $prefix = "AIConnector 中文、换行与代码测试`n0123456789`n"
        $text = $prefix + ('x' * ($size - $script:Utf8.GetByteCount($prefix)))
        $files[('text-{0}.txt' -f $size)] = $script:Utf8.GetBytes($text)
    }
    $files['metrics.json'] = $script:Utf8.GetBytes('{"sample":true,"rank":0,"latency_us":12.5,"note":"合成测试数据"}')
    $files['metrics.csv'] = $script:Utf8.GetBytes("rank,latency_us`n0,12.5`n1,13.5`n")
    $files['pixel.png'] = [Convert]::FromBase64String('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMwaDgAAAJUAXHIMWMAAAAAAElFTkSuQmCC')
    foreach ($name in ($files.Keys | Sort-Object)) {
        [IO.File]::WriteAllBytes((Join-Path $dir $name), $files[$name])
        $manifest.Add([pscustomobject]@{name=$name; bytes=$files[$name].Length; sha256=(Get-Sha256 $files[$name]); url=''})
    }
    $manifestPath = Join-Path $dir 'manifest.json'
    [IO.File]::WriteAllText($manifestPath, (ConvertTo-Json -InputObject $manifest.ToArray() -Depth 5), $script:Utf8)
    Add-Observation 'samples' 'CREATED' '已生成合成文本、JSON、CSV、PNG 及校验清单；尚未上传。' @{directory=$dir; files=$manifest.ToArray()}
}
function Invoke-Exchange($Settings) {
    if ($Session -notmatch '^[A-Za-z0-9_-]{1,64}$' -or $Peer -notmatch '^[A-Za-z0-9_-]{1,64}$' -or $Peer -eq $Node) {
        Stop-Probe 'Send/Receive/Verify 需要相同 Session、不同的 Node 与 Peer；仅使用字母数字、下划线和短横线。'
    }
    $matches = @($Settings.channels | Where-Object { $_.name -eq $Channel })
    if ($matches.Count -ne 1) { Stop-Probe 'Channel 必须匹配配置中唯一的通道名称。' }
    $c = $matches[0]
    $token = Get-Token $c
    if ($PromptToken) {
        $secure = Read-Host '输入平台 Token（不会写入报告）' -AsSecureString
        $token = (New-Object Net.NetworkCredential('', $secure)).Password
    }
    $script:Token = $token
    if ($Mode -in @('Send','Receive') -and -not $token) { Stop-Probe '发送测试评论需要 Token；设置配置指定的环境变量或使用 -PromptToken。' }
    $comments = Get-Comments $c $token
    $packets = @($comments | ForEach-Object { Read-Packet ([string]$_.body) } | Where-Object { $null -ne $_ })
    if ($Mode -eq 'Send') {
        $prefix = "AIConnector 通道测试`n中文 / JSON / code / newline`n"
        $payload = $prefix + ('x' * ($SizeBytes - $script:Utf8.GetByteCount($prefix)))
        $id = Get-TextHash ($Session + '|' + $Node + '|' + $Peer + '|' + $SizeBytes)
        $p = [ordered]@{schema='aiconnector.probe.v1'; kind='sample'; message_id=$id; session=$Session; sender=$Node; receiver=$Peer
            payload_bytes=$SizeBytes; payload_sha256=(Get-TextHash $payload); payload=$payload}
        $posted = Publish-Packet $c $p $comments $token
        Add-Observation 'text_send' $posted.status '测试正文已提交或已存在；尚未证明对端收到。' $posted
    } elseif ($Mode -eq 'Receive') {
        $seen = @{}
        $samples = @($packets | Where-Object { $_.kind -eq 'sample' -and $_.session -eq $Session -and $_.sender -eq $Peer -and $_.receiver -eq $Node })
        if ($samples.Count -eq 0) { Add-Observation 'peer_receive' 'WAITING' '尚未发现匹配的对端样本。'; return }
        foreach ($p in $samples) {
            if ($seen.ContainsKey([string]$p.message_id)) { continue }; $seen[[string]$p.message_id] = $true
            $hash = Get-TextHash ([string]$p.payload)
            $bytes = $script:Utf8.GetByteCount([string]$p.payload)
            $expectedId = Get-TextHash ($Session + '|' + $Peer + '|' + $Node + '|' + $bytes)
            if ($hash -cne $p.payload_sha256 -or $bytes -ne $p.payload_bytes -or $bytes -gt 32768 -or $p.message_id -cne $expectedId) {
                Add-Observation 'peer_receive' 'PAYLOAD_INVALID' '样本标识、字节数或校验值不一致，不发送成功回执。'; continue
            }
            $ack = [ordered]@{schema='aiconnector.probe.v1'; kind='receipt'; message_id=(Get-TextHash ('receipt|' + $p.message_id + '|' + $Node)); session=$Session
                sender=$Node; receiver=$Peer; in_reply_to=$p.message_id; payload_sha256=$hash; payload_bytes=$bytes}
            $posted = Publish-Packet $c $ack $comments $token
            Add-Observation 'peer_receive' 'RECEIVED_AND_RECEIPT_POSTED' '本机校验了对端文本并提交回执；发送端还需要 Verify。' @{payload_bytes=$bytes; sha256=$hash; receipt=$posted}
            Start-Sleep -Milliseconds 1100
        }
    } else {
        $samples = @($packets | Where-Object { $_.kind -eq 'sample' -and $_.session -eq $Session -and $_.sender -eq $Node -and $_.receiver -eq $Peer })
        if ($samples.Count -eq 0) { Add-Observation 'roundtrip' 'WAITING' '未找到本节点发送的样本。'; return }
        foreach ($p in $samples) {
            $hash = Get-TextHash ([string]$p.payload)
            $bytes = $script:Utf8.GetByteCount([string]$p.payload)
            $expectedId = Get-TextHash ($Session + '|' + $Node + '|' + $Peer + '|' + $bytes)
            if ($hash -cne $p.payload_sha256 -or $bytes -ne $p.payload_bytes -or $bytes -gt 32768 -or $p.message_id -cne $expectedId) {
                Add-Observation 'roundtrip' 'PAYLOAD_INVALID' '发送样本已被修改或结构无效。'; continue
            }
            $acks = @($packets | Where-Object { $_.kind -eq 'receipt' -and $_.session -eq $Session -and $_.sender -eq $Peer -and $_.receiver -eq $Node -and $_.in_reply_to -eq $p.message_id -and $_.payload_sha256 -ceq $hash -and $_.payload_bytes -eq $bytes })
            if ($acks.Count -gt 0) {
                Add-Observation 'roundtrip' 'PEER_RECEIPT_VERIFIED' '已读到另一节点的匹配回执；此结论依赖两节点实际分别运行，且使用受控测试 Issue。' @{sender=$Node; receiver=$Peer; payload_bytes=$bytes; sha256=$hash}
            } else { Add-Observation 'roundtrip' 'WAITING' ('未收到匹配回执；样本字节数：' + $bytes) }
        }
        $script:Report.limits += '回执用于连通性测试，不是设备身份认证；同一台机器模拟两个节点不能证明跨网络成功。'
    }
}

$exitCode = 0
try {
    # Enable TLS 1.2 without disabling certificate validation (Windows PowerShell 5.1).
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    if ($Mode -eq 'Samples') { New-Samples }
    else {
        if (-not [IO.File]::Exists($Config) -and -not $PSBoundParameters.ContainsKey('Config')) {
            # A single copied script can run the initial read-only scan.
            $settings = [pscustomobject]@{ channels = @(
                [pscustomobject]@{name='gitcode';provider='gitcode';website='https://gitcode.com/';api_base='https://api.gitcode.com/api/v5';token_env='AICONNECTOR_GITCODE_TOKEN';repository='';issue=''},
                [pscustomobject]@{name='github';provider='github';website='https://github.com/';api_base='https://api.github.com';token_env='AICONNECTOR_GITHUB_TOKEN';repository='';issue=''}
            ); downloads = @() }
        } else { $settings = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($Config, $script:Utf8)) }
        if (-not (Get-Field $settings 'channels')) { Stop-Probe '配置缺少 channels。' }
        if ($Mode -eq 'Scan') { Invoke-Scan $settings } else { Invoke-Exchange $settings }
    }
} catch {
    # Only our controlled application messages are printable. Suppress parser/network exception details.
    $message = '运行未完成，请检查配置、参数及权限。'
    $errorObject = $_.Exception
    while ($null -ne $errorObject) {
        if ($errorObject.Data.Contains('probe_reason')) { $message = [string]$errorObject.Data['probe_reason']; break }
        $errorObject = $errorObject.InnerException
    }
    if ($script:Token) { $message = $message.Replace($script:Token, '[REDACTED]') }
    Add-Observation 'probe' 'ERROR' $message
    $exitCode = 2
} finally { Save-Report }
exit $exitCode
