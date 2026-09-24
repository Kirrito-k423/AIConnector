#requires -Version 5.1
<##
AIConnector channel probe. Windows PowerShell 5.1 / PowerShell 7.
No external modules. Default Scan performs GET requests only.
##>
[CmdletBinding()]
param(
    [ValidateSet('Scan', 'Samples', 'Send', 'Receive', 'Verify', 'Write')]
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
    [switch]$PromptToken,
    [switch]$ResumeUploads,
    [ValidateRange(0, 900)][int]$MaxUploadWaitSeconds = 180
)

$ErrorActionPreference = 'Stop'
if ($Mode -eq 'Write' -and -not $PSBoundParameters.ContainsKey('TimeoutSeconds')) { $TimeoutSeconds = 60 }
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
$script:Tokens = @{}
$script:Results = New-Object System.Collections.Generic.List[object]
$script:DownloadLimit = 16 * 1024 * 1024
$script:Report = [ordered]@{
    schema = 'aiconnector.report.v1'; version = '0.1.5'; node = $Node; mode = $Mode
    completed = $false
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
    $verified = @($script:Results | Where-Object { $_.status -in @('PASS','EXACT_BYTES_VERIFIED','AUTH_API_VERIFIED','PEER_RECEIPT_VERIFIED','COMMENT_BYTES_VERIFIED') })
    $script:Report['summary'] = [ordered]@{
        completed = $script:Report.completed; checked = $script:Results.Count; verified = $verified.Count
        conclusion = '完整检查记录已生成；只将明确验证的能力列为通过。未验证项目及原因见下表。'
        peer_verified = (@($script:Results | Where-Object { $_.status -eq 'PEER_RECEIPT_VERIFIED' }).Count -gt 0)
    }
    if (-not $script:Report.completed) { $script:Report.summary.conclusion = '本次运行未完成，请查看 ERROR 项；不能视为完整检查。' }
    [IO.File]::WriteAllText($jsonPath, ($script:Report | ConvertTo-Json -Depth 20), $script:Utf8)
    $lines = New-Object System.Collections.Generic.List[string]
    $lines.Add('# AIConnector 通道探测报告')
    $lines.Add('')
    $lines.Add(('节点：{0}；模式：{1}；路由：{2}；PowerShell：{3}' -f $Node,$Mode,$script:Report.route,$script:Report.powershell))
    $lines.Add(('时间：{0}' -f $script:Report.generated_at))
    $lines.Add('')
    $lines.Add($script:Report.summary.conclusion)
    $lines.Add('')
    $lines.Add('| 检查 | 状态 | 说明 |')
    $lines.Add('|---|---|---|')
    foreach ($r in $script:Results) {
        $lines.Add(('| {0} | {1} | {2} |' -f ($r.test -replace '[|\r\n]',' '),$r.status,($r.detail -replace '[|\r\n]',' ')))
    }
    $lines.Add('')
    foreach ($line in $script:Report.limits) { $lines.Add('- ' + $line) }
    [IO.File]::WriteAllText($mdPath, ($lines -join "`n"), $script:Utf8)
    $htmlPath = Join-Path $OutputDir ($stem + '.html')
    $encoded = [Net.WebUtility]::HtmlEncode(($lines -join "`n"))
    [IO.File]::WriteAllText($htmlPath, ('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>AIConnector 检查报告</title><style>body{max-width:1100px;margin:32px auto;padding:0 24px;font:16px/1.7 system-ui}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style><h1>AIConnector v0.1.5</h1><pre>' + $encoded + '</pre></html>'), $script:Utf8)
    Add-Type -AssemblyName System.IO.Compression
    $zipPath = Join-Path $OutputDir ($stem + '.zip')
    $stream = [IO.File]::Create($zipPath)
    $zip = New-Object IO.Compression.ZipArchive($stream, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($path in @($jsonPath,$mdPath,$htmlPath)) {
            $entry = $zip.CreateEntry([IO.Path]::GetFileName($path))
            $dest = $entry.Open()
            try { $bytes = [IO.File]::ReadAllBytes($path); $dest.Write($bytes,0,$bytes.Length) } finally { $dest.Dispose() }
        }
    } finally { $zip.Dispose(); $stream.Dispose() }
    Write-Host ('查看报告：' + $htmlPath)
    Write-Host ('回传这一个文件即可：' + $zipPath)
}

function Invoke-ProbeHttp {
    param([string]$Url, [string]$Method = 'GET', [hashtable]$Headers = @{},
        [string]$Body = '', [int]$Limit = 2097152, [bool]$Authenticated = $false,
        [byte[]]$BinaryBody = $null, [string]$MultipartFileName = '', [string]$BinaryContentType = 'application/octet-stream')
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
    if ($script:Tokens.ContainsKey([string]$C.name)) { return $script:Tokens[[string]$C.name] }
    $name = [string](Get-Field $C 'token_env')
    if (-not $name) { return '' }
    return [Environment]::GetEnvironmentVariable($name)
}
function Invoke-ChannelApi($C, [string]$Path, [string]$Method = 'GET', [string]$Body = '', [string]$Token = '', [byte[]]$BinaryBody = $null, [string]$MultipartFileName = '') {
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
    return Invoke-ProbeHttp -Url $url -Method $Method -Headers $headers -Body $Body -Authenticated ([bool]$Token) -BinaryBody $BinaryBody -MultipartFileName $MultipartFileName
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
    $body = 'AIConnector probe v1' + "`n`n" + '```json' + "`n" + ($Packet | ConvertTo-Json -Depth 8 -Compress) + "`n" + '```'
    if ($Packet.kind -eq 'attachment') { $body += "`n`n" + '[' + $Packet.name + '](' + $Packet.url + ')' }
    return $body
}
function Read-Packet([string]$Body) {
    if ($Body -match '(?s)\AAIConnector probe v1\r?\n\r?\n```json\r?\n(.+?)\r?\n```(?:\r?\n\r?\n\[[^\]\r\n]+\]\(https?://[^\s)]+\))?\s*\z') {
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
        if ($PromptToken -and -not $token) {
            $secure = Read-Host ($name + ' Token（可选，直接回车跳过；不会保存）') -AsSecureString
            $token = (New-Object Net.NetworkCredential('', $secure)).Password
        }
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
        if ($api.http -eq 403 -and -not $token) { $detail = '匿名身份 API 返回 403；尚不能区分认证要求、权限或网关拒绝，不能据此判断整个通道不可用。' }
        Add-Observation ($name + '/api') $status $detail (Get-Evidence $api)
        # Read targets are separate from exchange targets: public third-party
        # repositories must never become destinations for Send/Receive.
        $readRepo = [string](Get-Field $c 'read_repository' (Get-Field $c 'repository'))
        $readIssue = [string](Get-Field $c 'read_issue' (Get-Field $c 'issue'))
        if ($readRepo -and -not $readIssue) {
            if ($readRepo -notmatch '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$') { Stop-Probe '只读仓库格式无效。' }
            $list = Invoke-ChannelApi $c ('/repos/' + $readRepo + '/issues?state=all&per_page=1') 'GET' '' $token
            $ls = $list.status
            if ($ls -eq 'HTTP_OK') {
                if ($list.json -is [Array]) {
                    $ls = 'PASS'
                    if ($list.json.Count -gt 0) { $readIssue = [string](Get-Field $list.json[0] 'number') }
                } else { $ls = 'UNEXPECTED_API_RESPONSE' }
            }
            Add-Observation ($name + '/issue_list') $ls '自动检查预置公共仓库并选择一个 Issue 读取；不向该仓库写入。' (Get-Evidence $list)
        }
        if ($readRepo -and $readIssue) {
            try {
                $readTarget = [pscustomobject]@{repository=$readRepo;issue=$readIssue;api_base=$c.api_base;provider=$c.provider}
                $comments = Get-Comments $readTarget $token
                Add-Observation ($name + '/issue_read') 'PASS' ('读取并验证了评论数组，条数：' + $comments.Count)
            } catch {
                $detail = '未能完成评论读取；检查 Issue、凭据、响应结构和分页限制。'
                $e = $_.Exception
                while ($null -ne $e) {
                    if ($e.Data.Contains('probe_reason')) { $detail = [string]$e.Data['probe_reason']; break }
                    $e = $e.InnerException
                }
                Add-Observation ($name + '/issue_read') 'NOT_VERIFIED' $detail
            }
        } elseif ($readRepo) { Add-Observation ($name + '/issue_read') 'NOT_VERIFIED' '公共 Issue 列表未提供可读条目，原因见 issue_list；本次已记录，无需修改配置补测。' }
        else { Add-Observation ($name + '/issue_read') 'NOT_CONFIGURED' '当前配置没有只读测试目标。' }
        Add-Observation ($name + '/upload_and_peer') 'NOT_TESTED' 'Scan 不写入；跨机器文本用 Send/Receive/Verify 测试，附件上传尚未验证。'
    }
    foreach ($d in @(Get-Field $Settings 'downloads' @())) {
        try { $r = Invoke-ProbeHttp -Url $d.url -Limit $script:DownloadLimit }
        catch { Add-Observation ('download/' + $d.name) 'INVALID_TARGET' '下载目标格式无效，其他项目继续检查。'; continue }
        $expected = [string](Get-Field $d 'sha256')
        $status = $r.status
        $detail = '下载失败或未完成。'
        if ($status -eq 'HTTP_OK') {
            if (-not $expected) { $status = 'DOWNLOADED_UNVERIFIED'; $detail = '已获取响应；缺少原文件 SHA-256，无法排除登录页、转码或截断。' }
            elseif ($expected -notmatch '^[a-fA-F0-9]{64}$') { $status = 'INVALID_EXPECTED_HASH'; $detail = '配置中的 SHA-256 格式不正确。' }
            elseif ($expected.ToLowerInvariant() -eq $r.sha256) { $status = 'EXACT_BYTES_VERIFIED'; $detail = ('下载字节与原文件 SHA-256 一致，{0} 字节；只证明该文件，未测出容量上限。' -f $r.bytes) }
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

function New-WriteSamples {
    # In-memory synthetic bytes only. Never enumerate or upload the user's files.
    $files = New-Object System.Collections.Generic.List[object]
    foreach ($size in @(1024,32768)) { $files.Add([pscustomobject]@{name=('text-' + $size + '.txt'); mime='text/plain'; data=$script:Utf8.GetBytes(('x' * $size))}) }
    $files.Add([pscustomobject]@{name='metrics.json'; mime='application/json'; data=$script:Utf8.GetBytes('{"synthetic":true,"note":"中文","latency_us":12.5}')})
    $files.Add([pscustomobject]@{name='metrics.csv'; mime='text/csv'; data=$script:Utf8.GetBytes("rank,latency_us`n0,12.5`n")})
    $files.Add([pscustomobject]@{name='pixel.png'; mime='image/png'; data=[Convert]::FromBase64String('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGMwaDgAAAJUAXHIMWMAAAAAAElFTkSuQmCC')})
    $binary = New-Object byte[] 1048576
    $seed = [byte[]](0..255)
    for ($i=0; $i -lt $binary.Length; $i+=256) { [Buffer]::BlockCopy($seed,0,$binary,$i,256) }
    $files.Add([pscustomobject]@{name='binary-1MiB.bin'; mime='application/octet-stream'; data=$binary})
    Add-Type -AssemblyName System.IO.Compression
    $mem = New-Object IO.MemoryStream
    $zip = New-Object IO.Compression.ZipArchive($mem,[IO.Compression.ZipArchiveMode]::Create,$true)
    try {
        $entry = $zip.CreateEntry('sample.bin',[IO.Compression.CompressionLevel]::NoCompression)
        $entry.LastWriteTime = [DateTimeOffset]::new(2026,1,1,0,0,0,[TimeSpan]::Zero)
        $dest = $entry.Open(); try { $dest.Write($binary,0,131072) } finally { $dest.Dispose() }
    } finally { $zip.Dispose() }
    $files.Add([pscustomobject]@{name='result-128KiB.zip'; mime='application/zip'; data=$mem.ToArray()})
    $mem.Dispose()
    return ,($files.ToArray())
}
function Save-WriteState($State,[string]$Path) {
    [IO.Directory]::CreateDirectory($OutputDir) | Out-Null
    $temp = $Path + '.tmp'
    [IO.File]::WriteAllText($temp,(ConvertTo-Json -InputObject @($State) -Depth 8),$script:Utf8)
    Move-Item -LiteralPath $temp -Destination $Path -Force
}
function Initialize-UploadState($Row) {
    foreach ($entry in @{retry_after='';next_attempt_at='';attempts=0;verified=$false}.GetEnumerator()) {
        if ($null -eq $Row.PSObject.Properties[$entry.Key]) { $Row | Add-Member NoteProperty $entry.Key $entry.Value }
    }
    # v0.1.4 classified completed HTTP 429 responses as permanent rejections.
    if ($Row.status -eq 'UPLOAD_REJECTED' -and $Row.http -eq 429) { $Row.status = 'RATE_LIMITED' }
}
function Get-UploadCooldown([string]$Header,[int]$Attempt) {
    $now = [DateTime]::UtcNow
    $seconds = 0L; $date = [DateTimeOffset]::MinValue
    if ([long]::TryParse($Header,[ref]$seconds) -and $seconds -ge 0 -and $seconds -le 31536000) {
        return $now.AddSeconds([Math]::Max(1,$seconds))
    }
    if ($Header.Length -le 128 -and [DateTimeOffset]::TryParse($Header,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::AssumeUniversal,[ref]$date)) {
        if ($date.UtcDateTime -gt $now) { return $date.UtcDateTime }
    }
    return $now.AddSeconds(60 * [Math]::Pow(2,[Math]::Min(4,[Math]::Max(0,$Attempt-1))))
}
function Get-StoredUploadTime($Value) {
    # PowerShell 7 can deserialize ISO dates as DateTime; 5.1 leaves strings.
    if ($Value -is [DateTime]) { return $Value.ToUniversalTime() }
    if ($Value -is [DateTimeOffset]) { return $Value.UtcDateTime }
    $date = [DateTimeOffset]::MinValue
    if ($Value -and [DateTimeOffset]::TryParse([string]$Value,[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::AssumeUniversal,[ref]$date)) { return $date.UtcDateTime }
    return [DateTime]::MinValue
}
function Wait-UploadSlot($Row) {
    $next = $script:UploadNotBefore
    $saved = Get-StoredUploadTime $Row.next_attempt_at
    if ($saved -gt $next) { $next = $saved }
    $seconds = [Math]::Max(0.0,($next - [DateTime]::UtcNow).TotalSeconds)
    if ($seconds -gt $script:UploadWaitRemaining) {
        $Row.next_attempt_at = $next.ToString('o')
        if ($Row.status -ne 'RATE_LIMITED') { $Row.status = 'DEFERRED_RATE_LIMIT' }
        return $false
    }
    if ($seconds -gt 0) { Write-Host ('等待上传冷却：约 {0} 秒，之后继续未完成项。' -f [Math]::Ceiling($seconds)) }
    $script:UploadWaitRemaining -= $seconds
    while ([DateTime]::UtcNow -lt $next) {
        $ms = [Math]::Min(30000.0,[Math]::Max(1.0,[Math]::Ceiling(($next-[DateTime]::UtcNow).TotalMilliseconds)))
        Start-Sleep -Milliseconds ([int]$ms)
    }
    return $true
}
function Get-GitHubRelease($C,[string]$Token) {
    $tag = [string](Get-Field $C 'release_tag')
    if ($tag -notmatch '^[A-Za-z0-9_.-]{1,64}$') { Stop-Probe 'ZIP 通道的 release_tag 无效。' }
    $r = Invoke-ChannelApi $C ('/repos/'+$C.repository+'/releases/tags/'+$tag) 'GET' '' $Token
    $id = [string](Get-Field $r.json 'id')
    if ($r.status -ne 'HTTP_OK' -or $id -notmatch '^[1-9][0-9]*$' -or (Get-Field $r.json 'draft' $true)) { Stop-Probe '无法读取已公开的 ZIP 测试 Release；没有创建或修改发布。' }
    $upload = ([string](Get-Field $r.json 'upload_url')) -replace '\{.*$',''
    $uri = Assert-Url $upload; $api = Assert-Url $C.api_base
    if (-not (($uri.Scheme -eq 'https' -and $uri.Host -eq 'uploads.github.com') -or ($api.IsLoopback -and $uri.IsLoopback -and $api.Authority -eq $uri.Authority))) { Stop-Probe 'Release 上传地址不在可信目标中。' }
    $assets = New-Object System.Collections.Generic.List[object]
    for ($page=1; $page -le $MaxPages; $page++) {
        $a = Invoke-ChannelApi $C ('/repos/'+$C.repository+'/releases/'+$id+'/assets?per_page=100&page='+$page) 'GET' '' $Token
        if ($a.status -ne 'HTTP_OK' -or $a.json -isnot [Array]) { Stop-Probe 'Release 资产列表未完整读取，停止上传以避免重复。' }
        foreach ($asset in $a.json) { $assets.Add($asset) }
        if ($a.json.Count -lt 100) { return [pscustomobject]@{upload_url=$upload;assets=$assets.ToArray()} }
    }
    Stop-Probe 'Release 资产列表达到分页上限，未上传。'
}
function Read-PeerReleaseZips($C,$Comments) {
    $tag = [string](Get-Field $C 'release_tag')
    if ($C.provider -ne 'github' -or -not $tag) { return }
    $seen = @{}; $count = 0
    foreach ($comment in $Comments) {
        $p = Read-Packet ([string]$comment.body)
        if ($null -eq $p -or $p.kind -ne 'attachment' -or $p.session -ne $Session -or $p.sender -ne $Peer -or $p.receiver -ne $Node) { continue }
        if ([string]$p.name -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\.zip$' -or [string]$p.sha256 -cnotmatch '^[a-f0-9]{64}$') { continue }
        $key = 'release|'+$tag+'|'+$p.name+'|'+$p.sha256
        $id = Get-TextHash ('asset|'+$Session+'|'+$Peer+'|'+$key)
        if ($p.message_id -cne $id -or $seen.ContainsKey($id)) { continue }
        $seen[$id] = $true; $count++
        if ($count -gt 5) { Add-Observation ($C.name+'/peer-zip') 'NOT_VERIFIED' '本次最多检查五个对端 ZIP；其余保留待查。'; break }
        $test = $C.name+'/peer-zip/'+$id.Substring(0,12)
        try {
            $u = Assert-Url ([string]$p.url); $api = Assert-Url $C.api_base
            $allowed = $u.Scheme -eq 'https' -and $u.Host -eq 'github.com' -and $u.AbsolutePath.StartsWith('/'+$C.repository+'/releases/download/'+$tag+'/',[StringComparison]::Ordinal)
            $fixture = $api.IsLoopback -and $u.IsLoopback -and $api.Authority -eq $u.Authority
            if ((-not $allowed -and -not $fixture) -or $u.Query -or $u.Fragment -or [long]$p.bytes -le 0 -or [long]$p.bytes -ge 5242880) { throw 'invalid peer artifact' }
        } catch { Add-Observation $test 'INVALID_TARGET' '对端 ZIP 的目标、大小或协议字段无效，未发出下载请求。'; continue }
        $back = Invoke-ProbeHttp -Url $u.AbsoluteUri -Limit 5242880
        $status = $back.status
        if ($status -eq 'HTTP_OK') {
            $status = 'HASH_MISMATCH'
            if ($back.bytes -eq [long]$p.bytes -and $back.sha256 -ceq [string]$p.sha256) { $status = 'EXACT_BYTES_VERIFIED' }
        }
        $evidence = Get-Evidence $back; $evidence['source_url']=$u.AbsoluteUri; $evidence['sender']=$Peer
        Add-Observation $test $status '从对端评论中的指定 Release 下载 ZIP，并核对其字节数及 SHA-256。未解压或执行内容。' $evidence
    }
}
function Invoke-WriteCheck($Settings) {
    if (-not $Session) { $Session = 'writecheck-v013' }
    if (-not $Peer) { $Peer = 'mac-outer'; if ($Node -eq 'mac-outer') { $Peer = 'windows-inner' } }
    if ($Session -notmatch '^[A-Za-z0-9_-]{1,64}$' -or $Peer -notmatch '^[A-Za-z0-9_-]{1,64}$' -or $Peer -eq $Node) { Stop-Probe 'Session 与节点标识无效。' }
    $files = New-WriteSamples
    Write-Host '写入检查：仅向下列专用目标发布合成评论、样本及回执。'
    foreach ($c in $Settings.channels) { Write-Host ($c.name + ': ' + $c.repository + ' #' + $c.issue + ' Release=' + (Get-Field $c 'release_tag')) }
    if ($ResumeUploads) { Write-Host '恢复模式：跳过评论容量测试；保留成功项，只恢复明确限流或尚未发送的附件，并检查 ZIP Release 通道。' }
    foreach ($c in $Settings.channels) {
        $token = Get-Token $c
        if ($PromptToken -and -not $token) { $secure = Read-Host ($c.name + ' Token（隐藏输入；回车跳过）') -AsSecureString; $token = (New-Object Net.NetworkCredential('', $secure)).Password }
        $script:Tokens[[string]$c.name] = $token
    }
    foreach ($c in $Settings.channels) {
        $name = [string]$c.name; $token = Get-Token $c
        if (-not $token) { Add-Observation ($name+'/write') 'NEEDS_TOKEN' '本次缺少写入凭据，未执行写入。'; continue }
        $script:Token = $token
        try {
            $comments = Get-Comments $c $token
            Read-PeerReleaseZips $c $comments
            if (-not $ResumeUploads) {
                foreach ($size in @(1024,8192,32768)) {
                    $prefix = "AIConnector 通道测试`n中文 / JSON / code / newline`n"
                    $payload = $prefix + ('x' * ($size - $script:Utf8.GetByteCount($prefix)))
                    $id = Get-TextHash ($Session+'|'+$Node+'|'+$Peer+'|'+$size)
                    $packet = [ordered]@{schema='aiconnector.probe.v1';kind='sample';message_id=$id;session=$Session;sender=$Node;receiver=$Peer;payload_bytes=$size;payload_sha256=(Get-TextHash $payload);payload=$payload}
                    $posted = Publish-Packet $c $packet $comments $token
                    $comments = Get-Comments $c $token
                    $match = @($comments | Where-Object { [string]$_.id -eq $posted.comment_id })
                    if ($match.Count -ne 1 -or $match[0].body -cne (ConvertTo-PacketBody $packet)) { Stop-Probe '评论提交后独立读回不一致，停止该平台后续写入。' }
                    Add-Observation ($name+'/comment/'+$size) 'COMMENT_BYTES_VERIFIED' '独立 GET 读回的完整评论与发送内容一致。' @{payload_bytes=$size;sha256=$packet.payload_sha256;comment_id=$posted.comment_id;write_status=$posted.status}
                    if ($posted.status -eq 'POST_ACCEPTED') { Start-Sleep -Milliseconds 1100 }
                }
                $Channel = $name; $Mode = 'Receive'; $PromptToken = $false
                Invoke-Exchange $Settings
            }
            $statePath = Join-Path $OutputDir ('write-state-' + (Get-TextHash ($c.api_base+'|'+$c.repository+'|'+$c.issue+'|'+$Session+'|'+$Node)).Substring(0,20) + '.local.json')
            $state = New-Object System.Collections.Generic.List[object]
            $hasState = [IO.File]::Exists($statePath)
            if ($hasState) {
                $saved = ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($statePath,$script:Utf8))
                foreach ($r in @($saved)) { Initialize-UploadState $r; $state.Add($r) }
            }
            $script:UploadNotBefore = [DateTime]::MinValue
            $script:UploadWaitRemaining = [double]$MaxUploadWaitSeconds
            $interval = 1.1; if ($c.provider -eq 'gitcode') { $interval = 15.0 }
            $interval = [double](Get-Field $c 'upload_interval_seconds' $interval)
            if ($interval -lt 0 -or $interval -gt 300) { Stop-Probe '上传间隔必须为 0 到 300 秒。' }
            foreach ($r in $state) {
                $date = Get-StoredUploadTime $r.next_attempt_at
                if ($r.status -in @('RATE_LIMITED','DEFERRED_RATE_LIMIT') -and $date -gt $script:UploadNotBefore) { $script:UploadNotBefore = $date }
            }
            $targets = New-Object System.Collections.Generic.List[object]
            if (-not $ResumeUploads -or $hasState) {
                foreach ($f in $files) {
                    $fileKey = $f.name+'|'+(Get-Sha256 $f.data)
                    if ($ResumeUploads -and -not @($state | Where-Object { $_.key -ceq $fileKey }).Count) { continue }
                    $targets.Add([pscustomobject]@{file=$f;transport='attachment';key=$fileKey})
                }
            } else { Add-Observation ($name+'/resume') 'NO_PREVIOUS_STATE' '未找到旧上传记录；请将新包覆盖到旧目录并保留 reports。未重跑附件容量测试。' }
            $tag = [string](Get-Field $c 'release_tag')
            if ($c.provider -eq 'github' -and $tag) {
                $zip = @($files | Where-Object { $_.mime -eq 'application/zip' })[0]
                $targets.Add([pscustomobject]@{file=$zip;transport='release';key=('release|'+$tag+'|'+$zip.name+'|'+(Get-Sha256 $zip.data))})
            }
            $repoId = ''; $release = $null
            foreach ($target in $targets) {
                $f = $target.file; $sha = Get-Sha256 $f.data; $key = $target.key
                $test = $name+'/'+$target.transport+'/'+$f.name
                $known = @($state | Where-Object { $_.key -eq $key })
                if ($known.Count) { $row = $known[0] }
                else {
                    $row = [pscustomobject]@{key=$key;name=$f.name;sha256=$sha;bytes=$f.data.Length;status='PENDING';url='';http=0}
                    Initialize-UploadState $row; $state.Add($row)
                }
                if ($row.url) {
                    $savedUri = Assert-Url $row.url
                    if ($savedUri.Query -or $savedUri.Fragment) { Stop-Probe '旧上传记录包含临时签名地址，未写入报告或评论。' }
                }
                if ($row.verified -and $row.status -eq 'UPLOADED') {
                    Add-Observation $test 'PREVIOUSLY_VERIFIED' '保留上次字节校验结果，本次未重复上传或下载。' @{bytes=$row.bytes;sha256=$row.sha256;source_url=$row.url}; continue
                }
                $assetName = 'aiconnector-'+$Session+'-'+$Node+'-'+$sha+'-'+$f.name
                if ($target.transport -eq 'release' -and $row.status -ne 'UPLOADED') {
                    if ($null -eq $release) { $release = Get-GitHubRelease $c $token }
                    $found = @($release.assets | Where-Object { $_.name -ceq $assetName })
                    if ($found.Count -eq 1 -and $found[0].state -eq 'uploaded' -and $found[0].size -eq $f.data.Length) {
                        $candidate = [string]$found[0].browser_download_url; $candidateUri = Assert-Url $candidate
                        if ($candidateUri.Query -or $candidateUri.Fragment) { Stop-Probe 'Release 未返回可保存的稳定下载地址。' }
                        $row.url = $candidate
                        $row.status = 'UPLOADED'
                    } elseif ($found.Count) { $row.status = 'ASSET_CONFLICT' }
                }
                $rateAttempts = 0
                while ($row.status -in @('PENDING','RATE_LIMITED','DEFERRED_RATE_LIMIT')) {
                    if (-not (Wait-UploadSlot $row)) { Save-WriteState $state.ToArray() $statePath; break }
                    $row.status = 'WRITE_UNCERTAIN'; $row.attempts = [int]$row.attempts + 1; $row.next_attempt_at = ''
                    Save-WriteState $state.ToArray() $statePath
                    if ($target.transport -eq 'release') {
                        $url = $release.upload_url+'?name='+[Uri]::EscapeDataString($assetName)
                        $up = Invoke-ProbeHttp -Url $url -Method POST -BinaryBody $f.data -BinaryContentType 'application/zip' -Headers @{Authorization=('Bearer '+$token);Accept='application/vnd.github+json'} -Authenticated $true
                        $row.url = [string](Get-Field $up.json 'browser_download_url')
                    } elseif ($c.provider -eq 'github') {
                        if (-not $repoId) {
                            $meta = Invoke-ChannelApi $c ('/repos/'+$c.repository) 'GET' '' $token
                            $repoId = [string](Get-Field $meta.json 'id')
                            if ($meta.status -ne 'HTTP_OK' -or $repoId -notmatch '^[1-9][0-9]*$') { Stop-Probe '无法确定附件所属仓库 ID。' }
                        }
                        $base = [string](Get-Field $c 'asset_upload_base' 'https://uploads.github.com')
                        $url = $base.TrimEnd('/')+'/user-attachments/assets?repository_id='+$repoId+'&name='+[Uri]::EscapeDataString($f.name)+'&content_type='+[Uri]::EscapeDataString($f.mime)
                        $up = Invoke-ProbeHttp -Url $url -Method POST -BinaryBody $f.data -Headers @{Authorization=('Bearer '+$token);Accept='application/vnd.github+json'} -Authenticated $true
                        $row.url = [string](Get-Field $up.json 'url')
                    } elseif ($f.mime -eq 'image/png') {
                        $body = @{body=[Convert]::ToBase64String($f.data);file_name=$f.name} | ConvertTo-Json -Compress
                        $up = Invoke-ChannelApi $c ('/repos/'+$c.repository+'/img/upload') 'POST' $body $token
                        $row.url = [string](Get-Field $up.json 'full_path')
                    } else {
                        $up = Invoke-ChannelApi $c ('/repos/'+$c.repository+'/file/upload') 'POST' '' $token -BinaryBody $f.data -MultipartFileName $f.name
                        $row.url = [string](Get-Field $up.json 'full_path')
                    }
                    $script:UploadNotBefore = [DateTime]::UtcNow.AddSeconds($interval)
                    $row.http = $up.http; $row.retry_after = ''
                    if ($up.status -eq 'RATE_LIMITED') {
                        $rateAttempts++
                        $row.status = 'RATE_LIMITED'; $row.url = ''
                        $cooldown = Get-UploadCooldown $up.retry_after $rateAttempts
                        # RetryAfter comes from the typed HTTP header, never an error body.
                        $row.retry_after = $up.retry_after; $row.next_attempt_at = $cooldown.ToString('o')
                        if ($cooldown -gt $script:UploadNotBefore) { $script:UploadNotBefore = $cooldown }
                    } elseif ($up.status -eq 'HTTP_OK' -and $row.url) {
                        $assetUri = Assert-Url $row.url
                        if ($assetUri.Query -or $assetUri.Fragment) { $row.url=''; Stop-Probe '附件接口返回临时签名地址，未将其保存到报告。' }
                        $row.status = 'UPLOADED'
                    } elseif ($up.http -ge 400 -and $up.http -lt 500 -and $up.status -notin @('TIMEOUT','NETWORK_ERROR','BODY_LIMIT_EXCEEDED')) { $row.status = 'UPLOAD_REJECTED'; $row.url = '' }
                    Save-WriteState $state.ToArray() $statePath
                    if ($row.status -ne 'RATE_LIMITED' -or $rateAttempts -ge 3) { break }
                }
                Save-WriteState $state.ToArray() $statePath
                if ($row.status -ne 'UPLOADED') {
                    Add-Observation $test $row.status '限流项保留冷却时间与待测状态；其他拒绝或未知写入不自动重发。' @{http=$row.http;bytes=$row.bytes;sha256=$row.sha256;retry_after=$row.retry_after;next_attempt_at=$row.next_attempt_at;attempts=$row.attempts}; continue
                }
                $assetUri = Assert-Url $row.url
                if ($assetUri.Query -or $assetUri.Fragment) { Stop-Probe '不能将临时签名地址发布到评论。' }
                $packet = [ordered]@{schema='aiconnector.probe.v1';kind='attachment';message_id=(Get-TextHash ('asset|'+$Session+'|'+$Node+'|'+$key));session=$Session;sender=$Node;receiver=$Peer;name=$f.name;bytes=$f.data.Length;sha256=$sha;url=$row.url}
                $posted = Publish-Packet $c $packet $comments $token
                $comments = Get-Comments $c $token
                $match = @($comments | Where-Object { [string]$_.id -eq $posted.comment_id })
                if ($match.Count -ne 1 -or $match[0].body -cne (ConvertTo-PacketBody $packet)) { Stop-Probe '附件链接评论独立读回不一致，未验证传输成功。' }
                $back = Invoke-ProbeHttp -Url $row.url -Limit $script:DownloadLimit
                $status = $back.status
                if ($status -eq 'HTTP_OK') {
                    $status = 'HASH_MISMATCH'
                    if ($back.sha256 -ceq $sha -and $back.bytes -eq $f.data.Length) { $status = 'EXACT_BYTES_VERIFIED'; $row.verified = $true }
                }
                Save-WriteState $state.ToArray() $statePath
                $evidence = Get-Evidence $back; $evidence['source_url'] = $row.url
                Add-Observation $test $status '发布稳定文件链接，再匿名下载核对字节及 SHA-256；对端应使用 source_url。' $evidence
            }
        } catch {
            $detail = '该平台写入未完成；其他平台继续。'
            $e = $_.Exception
            while ($null -ne $e) { if ($e.Data.Contains('probe_reason')) { $detail=[string]$e.Data['probe_reason'];break };$e=$e.InnerException }
            Add-Observation ($name+'/write') 'NOT_VERIFIED' $detail @{error_type=$_.Exception.GetType().Name;script_line=$_.InvocationInfo.ScriptLineNumber}
        }
    }
    $script:Token = ''; $script:Tokens.Clear()
    $script:Report.limits += '附件接口拒绝不等于浏览器上传也被拒绝；单端写入读回不等于另一台机器收到。仅明确 429 按冷却时间有限恢复；未知上传不自动重发。'
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
        if ($Mode -eq 'Scan') { Invoke-Scan $settings } elseif ($Mode -eq 'Write') { Invoke-WriteCheck $settings } else { Invoke-Exchange $settings }
    }
    $script:Report.completed = $true
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
