#Requires -Version 7.2
[CmdletBinding()]
param(
    [string]$RuntimeZip,
    [string]$SourceHost,
    [string]$RemotePath,
    [string]$Python,
    [Parameter(Mandatory)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$Sha256,
    [switch]$Apply
)
$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$boundary = $repository.TrimEnd('\','/') + [IO.Path]::DirectorySeparatorChar
$limit = 512MB
$stage = $null; $receipt = $null; $applyLock = $null; $ownsGuard = $false; $http = $null
$updates = Join-Path $repository '.task/runtime-updates'
$guard = Join-Path $updates 'apply-state.json'
$stopReason = $null
function Stop-Update([string]$Reason) { $script:stopReason = $Reason; throw 'Update stopped by a preflight contract.' }
function Same-Start([datetime]$Actual, [datetime]$Saved) {
    return $Actual.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.ffffffZ') -ceq $Saved.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.ffffffZ')
}

function Plain-Path([string]$Path, [switch]$Inside) {
    $full = [IO.Path]::GetFullPath($Path)
    if ($full.StartsWith('\\')) { throw 'Use local files; remote transport must use the configured SSH route.' }
    if ($Inside -and !$full.StartsWith($boundary,[StringComparison]::OrdinalIgnoreCase)) { throw 'Path escaped this repository.' }
    $cursor = $full
    while ($cursor) {
        if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Linked paths are not permitted.' }
        $parent = Split-Path -Parent $cursor
        if ($parent -eq $cursor) { break }; $cursor = $parent
    }
    return $full
}
function Read-Json([string]$Path, [int]$Maximum = 32768) {
    $full = Plain-Path $Path -Inside; $item = Get-Item -LiteralPath $full
    if ($item.PSIsContainer -or $item.Length -gt $Maximum) { throw 'Receipt exceeds its allowed size.' }
    return [IO.File]::ReadAllText($full,[Text.UTF8Encoding]::new($false,$true)) | ConvertFrom-Json
}
function Write-Json([string]$Path, $Value) {
    $full = Plain-Path $Path -Inside; $temporary = $full + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    [IO.File]::WriteAllText($temporary,($Value | ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $full -Force
}
function Phase([string]$Name) {
    $receipt.phase = $Name; $receipt.updatedUtc = [DateTime]::UtcNow.ToString('O')
    Write-Json (Join-Path $stage 'receipt.json') $receipt
    if ($ownsGuard) { Write-Json $guard $receipt }
}
function Runtime-Name([string]$Name) {
    if ($Name -match '(?i)(^|/)(credentials?[^/]*|secrets?[^/]*|(?:token|password)[^/]*\.(?:json|txt|ya?ml)|private\.json|auth\.json|connection\.json|connector\.json|VIEWER-KEY[^/]*|\.env(?:\.[^/]*)?)$|\.(?:db(?:-[^/]*)?|sqlite(?:3)?(?:-[^/]*)?|log(?:\.[^/]*)?|key|pem|pfx|p12)$') { throw 'Runtime inputs contain private state or logs.' }
}
function Runtime-Files([string]$Directory) {
    $root = Plain-Path $Directory -Inside; $pending = [Collections.Generic.Stack[string]]::new(); $pending.Push($root)
    $count = 0; [long]$total = 0
    while ($pending.Count) {
        foreach ($item in Get-ChildItem -LiteralPath $pending.Pop() -Force) {
            $count++; if ($count -gt 10000) { throw 'Runtime directory contains too many entries.' }
            $null = Plain-Path $item.FullName -Inside
            Runtime-Name $item.FullName.Substring($root.Length + 1).Replace('\','/')
            if ($item.PSIsContainer) { $pending.Push($item.FullName) } else {
                $total += $item.Length
                if ($count -gt 10000 -or $total -gt $limit) { throw 'Runtime directory exceeds the update budget.' }
                $item.FullName
            }
        }
    }
}
function Required-Runtime([string]$Server, [string]$Desktop) {
    foreach ($name in @('AgenticView.Server.dll','AgenticView.Server.runtimeconfig.json','AgenticView.Server.deps.json','wwwroot/index.html')) {
        $file = Plain-Path (Join-Path $Server $name) -Inside
        if (!(Test-Path -LiteralPath $file -PathType Leaf) -or (Get-Item -LiteralPath $file).Length -eq 0) { throw 'Server runtime is incomplete.' }
    }
    foreach ($name in @('AgenticView.Desktop.exe','AgenticView.Desktop.dll','AgenticView.Desktop.runtimeconfig.json','AgenticView.Desktop.deps.json')) {
        $file = Plain-Path (Join-Path $Desktop $name) -Inside
        if (!(Test-Path -LiteralPath $file -PathType Leaf) -or (Get-Item -LiteralPath $file).Length -eq 0) { throw 'Desktop runtime is incomplete.' }
    }
}
function Download-Bundle([string]$Destination) {
    if ($SourceHost -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$' -or $RemotePath -notmatch '^(?:[A-Za-z]:/|/)[A-Za-z0-9_./-]+$' -or @($RemotePath.Split('/') | Where-Object { $_ -eq '..' -or $_ -eq '.' }).Count) { throw 'Use an existing SSH alias and a plain absolute remote path.' }
    $start = [Diagnostics.ProcessStartInfo]::new(); $start.FileName = (Get-Command scp.exe -CommandType Application).Source
    $start.UseShellExecute = $false; $start.CreateNoWindow = $true; $start.WindowStyle = 'Hidden'
    $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    foreach ($argument in @('-B','-q','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10','--',($SourceHost + ':' + $RemotePath),$Destination)) { $start.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::new(); $process.StartInfo = $start; $started = $false
    try {
        $started = $process.Start(); if (!$started) { throw 'Bundle download did not start.' }
        $discardOut = $process.StandardOutput.BaseStream.CopyToAsync([IO.Stream]::Null)
        $discardError = $process.StandardError.BaseStream.CopyToAsync([IO.Stream]::Null)
        $clock = [Diagnostics.Stopwatch]::StartNew()
        while (!$process.WaitForExit(100)) {
            if ($clock.Elapsed.TotalSeconds -ge 60 -or ((Test-Path -LiteralPath $Destination) -and (Get-Item -LiteralPath $Destination).Length -gt $limit)) { throw 'Bundle download exceeded its bounded allowance.' }
        }
        if ($process.ExitCode -ne 0) { throw 'Bundle download failed; existing SSH settings were retained.' }
    } finally {
        if ($started -and !$process.HasExited) { $process.Kill($true); $process.WaitForExit(3000) | Out-Null }
        $process.Dispose()
    }
}
function Extract-Bundle([string]$Bundle, [string]$Destination) {
    $archive = [IO.Compression.ZipFile]::OpenRead($Bundle)
    try {
        if ($archive.Entries.Count -gt 10000) { throw 'Bundle contains too many entries.' }
        $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        $kinds = [Collections.Generic.Dictionary[string,bool]]::new([StringComparer]::OrdinalIgnoreCase)
        [long]$total = 0; $entries = [Collections.Generic.List[object]]::new()
        foreach ($entry in $archive.Entries) {
            $name = $entry.FullName; $directory = $name.EndsWith('/'); $relative = $name.TrimEnd('/')
            if (!$relative -or $name.Length -gt 1024 -or $name.Contains('\') -or $name.Contains('//') -or $name.StartsWith('/') -or $relative -match '[\x00-\x1f\x7f\uFFFD<>:"|?*]' -or !$seen.Add($relative)) { throw 'Malformed or duplicate archive path.' }
            $segments = $relative.Split('/'); $partial = ''
            if ($segments.Length -gt 32) { throw 'Archive paths exceed the nesting limit.' }
            for ($index = 0; $index -lt $segments.Length; $index++) {
                $segment = $segments[$index]
                if (!$segment -or $segment -in @('.','..') -or $segment -match '[. ]$|^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') { throw 'Unsafe archive path segment.' }
                $partial = if ($partial) { $partial + '/' + $segment } else { $segment }
                $isDirectory = $index -lt $segments.Length - 1 -or $directory
                if ($kinds.ContainsKey($partial) -and (!$kinds[$partial] -or !$isDirectory)) { throw 'Archive file/directory paths conflict.' }
                $kinds[$partial] = $isDirectory
                if ($kinds.Count -gt 10000) { throw 'Implicit archive directories exceed the entry budget.' }
            }
            $type = ($entry.ExternalAttributes -shr 16) -band 0xF000
            if (($entry.ExternalAttributes -band 0x400) -or $type -notin @(0,0x4000,0x8000) -or $entry.Length -lt 0 -or $entry.Length -gt $limit) { throw 'Links and special archive entries are not permitted.' }
            if (($type -eq 0x4000 -and !$directory) -or ($type -eq 0x8000 -and $directory) -or ($directory -and $entry.Length -ne 0)) { throw 'Archive entry type differs from its path.' }
            Runtime-Name $relative; $total += $entry.Length
            if ($total -gt $limit) { throw 'Expanded runtime exceeds 512 MiB.' }
            $target = Plain-Path (Join-Path $Destination $relative) -Inside
            if (!$target.StartsWith($Destination + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Archive path escaped staging.' }
            $entries.Add(@{ entry = $entry; target = $target; directory = $directory })
        }
        $buffer = [byte[]]::new(65536)
        foreach ($item in $entries) {
            if ($item.directory) { [IO.Directory]::CreateDirectory($item.target) | Out-Null; continue }
            [IO.Directory]::CreateDirectory((Split-Path -Parent $item.target)) | Out-Null
            $readStream = $item.entry.Open(); $writeStream = [IO.File]::Open($item.target,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
            try {
                [long]$written = 0
                while (($read = $readStream.Read($buffer,0,$buffer.Length)) -gt 0) { $written += $read; if ($written -gt $item.entry.Length) { throw 'Archive expanded beyond its declared size.' }; $writeStream.Write($buffer,0,$read) }
                if ($written -ne $item.entry.Length) { throw 'Archive entry was truncated.' }
            } finally { $writeStream.Dispose(); $readStream.Dispose() }
        }
    } finally { $archive.Dispose() }
}
function Owned-Hub($State) {
    $entry = Plain-Path ([string]$State.Entry) -Inside; $data = Plain-Path ([string]$State.Data) -Inside
    $preview = (Join-Path $repository '.task/preview') + [IO.Path]::DirectorySeparatorChar
    if (!$entry.StartsWith($preview,[StringComparison]::OrdinalIgnoreCase) -or !$data.StartsWith($preview,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($entry) -ne 'AgenticView.Server.dll') { throw 'Original preview custody is unavailable.' }
    $url = [uri]$State.Url
    if (!$url.IsLoopback -or $url.Scheme -notin @('http','https') -or $url.UserInfo -or $url.Query -or $url.Fragment) { throw 'Original hub must use its loopback URL.' }
    $process = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$State.ProcessId)
    $dotnet = (Get-Command dotnet -CommandType Application).Source
    if (!$process -or $process.ExecutablePath -ne $dotnet -or !$process.CommandLine -or !$process.CommandLine.Contains('"' + $entry + '"')) { throw 'Original hub process ownership differs from its receipt.' }
    if ($State.CreatedUtc -and !(Same-Start $process.CreationDate ([datetime]$State.CreatedUtc))) { throw 'Original hub process creation identity differs.' }
    $listeners = @(Get-NetTCPConnection -LocalPort $url.Port -State Listen -ErrorAction SilentlyContinue)
    if (!$listeners.Count -or @($listeners | Where-Object OwningProcess -ne $process.ProcessId).Count) { throw 'Original hub listener ownership differs.' }
    return @{ ProcessId=$process.ProcessId; Executable=$process.ExecutablePath; CreatedUtc=$process.CreationDate.ToUniversalTime().ToString('O'); Entry=$entry; Data=$data; Url=$url.AbsoluteUri }
}
function Http-Json([string]$Path) {
    $timeout = [Threading.CancellationTokenSource]::new([TimeSpan]::FromSeconds(5)); $response = $null
    try {
        $response = $http.GetAsync($Path,[Net.Http.HttpCompletionOption]::ResponseHeadersRead,$timeout.Token).GetAwaiter().GetResult()
        if (!$response.IsSuccessStatusCode -or $response.Content.Headers.ContentLength -gt 8MB) { throw 'Bounded hub inspection was unavailable.' }
        $stream = $response.Content.ReadAsStream(); $body = [IO.MemoryStream]::new(); $buffer = [byte[]]::new(16384)
        try { while (($read = $stream.ReadAsync($buffer,0,$buffer.Length,$timeout.Token).GetAwaiter().GetResult()) -gt 0) { if ($body.Length + $read -gt 8MB) { throw 'Hub inspection exceeds its display budget.' }; $body.Write($buffer,0,$read) }; return [Text.UTF8Encoding]::new($false,$true).GetString($body.ToArray()) | ConvertFrom-Json }
        finally { $body.Dispose(); $stream.Dispose() }
    } finally { if ($response) { $response.Dispose() }; $timeout.Dispose() }
}
function Persisted-Sessions([string]$Data) {
    if (!$Python) { Stop-Update 'Apply requires -Python pointing to an existing interpreter for read-only persisted session inspection.' }
    $executable = Plain-Path $Python; $helper = Plain-Path (Join-Path $PSScriptRoot 'inspect-session-inventory.py') -Inside
    $database = Plain-Path (Join-Path $Data 'controls.sqlite') -Inside
    foreach ($file in @($executable,$helper,$database)) { if (!(Test-Path -LiteralPath $file -PathType Leaf)) { Stop-Update 'The selected Python, fixed inspection helper or existing controls database is unavailable.' } }
    $start = [Diagnostics.ProcessStartInfo]::new(); $start.FileName = $executable; $start.UseShellExecute = $false; $start.CreateNoWindow = $true; $start.WindowStyle = 'Hidden'
    $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
    foreach ($argument in @('-I','-B',$helper,'--database',$database)) { $start.ArgumentList.Add($argument) }
    $process = [Diagnostics.Process]::new(); $process.StartInfo = $start; $started = $false
    try {
        $started = $process.Start(); if (!$started) { throw 'Persisted session inspection did not start.' }
        $output = $process.StandardOutput.ReadToEndAsync(); $discard = $process.StandardError.BaseStream.CopyToAsync([IO.Stream]::Null)
        if (!$process.WaitForExit(10000)) { throw 'Persisted session inspection exceeded ten seconds.' }
        $text = $output.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0 -or $text.Length -gt 1MB) { Stop-Update 'Persisted session inventory was unavailable or oversized; no outputs were changed.' }
        $inventory = $text | ConvertFrom-Json
        if (@($inventory.PSObject.Properties.Name | Where-Object { $_ -notin @('schemaVersion','count','busy','sessions') }).Count -or ($inventory.schemaVersion -isnot [long] -and $inventory.schemaVersion -isnot [int]) -or $inventory.schemaVersion -ne 1 -or $inventory.busy -isnot [bool]) { Stop-Update 'Persisted session inventory returned an unknown schema.' }
        if ($inventory.count -isnot [long] -and $inventory.count -isnot [int]) { throw 'Malformed persisted session inventory.' }
        if ($inventory.sessions -isnot [array] -or $inventory.count -ne $inventory.sessions.Count -or $inventory.count -lt 0 -or $inventory.count -gt 1000) { Stop-Update 'Persisted session inventory exceeds its bounded schema.' }
        if ($inventory.busy) { Stop-Update 'Finish or pause managed sessions and wait for active leases to end before applying.' }
        $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($session in $inventory.sessions) {
            if (@($session.PSObject.Properties.Name | Where-Object { $_ -notin @('id','runId','state','desiredState','leaseActive') }).Count) { throw 'Unexpected persisted session fields.' }
            if ($session.id -notmatch '^[A-Za-z0-9_.:-]{1,120}$' -or $session.runId -notmatch '^[A-Za-z0-9_.:-]{1,120}$' -or !$seen.Add($session.id) -or $session.leaseActive -isnot [bool] -or $session.state -notin @('draft','queued','running','starting','recovering','paused','completed','error','offline') -or $session.desiredState -notin @('running','paused','completed')) { throw 'Unknown or malformed persisted session state.' }
            if ($session.leaseActive -or $session.state -in @('queued','running','starting','recovering') -or $session.desiredState -eq 'running') { Stop-Update 'Finish or pause managed sessions and wait for active leases to end before applying.' }
        }
        return $inventory.count
    } finally { if ($started -and !$process.HasExited) { $process.Kill($true); $process.WaitForExit(3000) | Out-Null }; $process.Dispose() }
}
function Quiescent-Sessions {
    $snapshot = Http-Json '/api/snapshot'; $sessions = @{}
    if ($snapshot.agents -isnot [array] -or $snapshot.agents.Count -gt 2000 -or $null -eq $snapshot.revision) { throw 'Malformed or oversized hub snapshot.' }
    foreach ($agent in @($snapshot.agents)) {
        $ids = @(); if ($agent.managedSessionId) { $ids += [string]$agent.managedSessionId }
        foreach ($component in @($agent.components.PSObject.Properties)) { if ($component.Value.kind -eq 'agent-session') { $ids += [string]$component.Value.data.sessionId } }
        foreach ($id in $ids) {
            if ($id -notmatch '^[A-Za-z0-9_.:-]{1,120}$') { throw 'Managed session identity is invalid.' }
            if ($sessions.ContainsKey($id)) { if ($sessions[$id] -ne $agent.id) { throw 'Managed session appears on different cards.' }; continue }
            $session = Http-Json ('/api/sessions/' + [uri]::EscapeDataString($id))
            if ($session.id -ne $id -or $session.runId -ne $agent.id -or !$session.state -or !$session.desiredState) { throw 'Managed session/card ownership could not be established.' }
            if ($session.state -in @('queued','running','starting','recovering') -or $session.desiredState -eq 'running') { Stop-Update 'Finish or pause managed sessions before applying this update.' }
            $sessions[$id] = [string]$agent.id
        }
    }
    return $sessions.Count
}

try {
    if (!(Test-Path -LiteralPath (Join-Path $repository '.git'))) { throw 'An existing AgenticView repository is required.' }
    if (($RuntimeZip -and ($SourceHost -or $RemotePath)) -or (!$RuntimeZip -and (!$SourceHost -or !$RemotePath))) { throw 'Supply either a local runtime ZIP or an existing SSH alias plus remote path.' }
    $null = Plain-Path $updates -Inside; [IO.Directory]::CreateDirectory($updates) | Out-Null
    if ($Apply) {
        $applyLock = [IO.File]::Open((Plain-Path (Join-Path $updates 'apply.lock') -Inside),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
        if (Test-Path -LiteralPath $guard) {
            $previous = Read-Json $guard
            if ($previous.phase -ne 'complete') { throw 'A retained update requires inspection before another Apply.' }
            if ($previous.sha256 -eq $Sha256.ToLowerInvariant()) {
                $current = Owned-Hub (Read-Json (Join-Path $repository '.task/preview-session.json'))
                if (!$previous.newHub -or $current.ProcessId -ne $previous.newHub.ProcessId -or $current.Entry -ne $previous.newHub.Entry -or !(Same-Start ([datetime]$current.CreatedUtc) ([datetime]$previous.newHub.CreatedUtc))) { throw 'The completed update no longer owns the current hub; inspect before another Apply.' }
                $previous | ConvertTo-Json -Depth 12; return
            }
        }
    }
    $stage = Plain-Path (Join-Path $updates ([guid]::NewGuid().ToString('N'))) -Inside; [IO.Directory]::CreateDirectory($stage) | Out-Null
    $bundle = Join-Path $stage 'runtime.zip'; $serverTarget = Plain-Path (Join-Path $repository 'dist/server') -Inside; $desktopTarget = Plain-Path (Join-Path $repository 'dist/desktop') -Inside
    $receipt = [ordered]@{ phase='staging'; updatedUtc=[DateTime]::UtcNow.ToString('O'); apply=[bool]$Apply; repository=$repository; stage=$stage; sha256=$Sha256.ToLowerInvariant(); bundle=$bundle; targets=@($serverTarget,$desktopTarget); backup=(Join-Path $stage 'backup'); newHub=$null; desktop='unchanged'; error=$null; relaunchCommand=("& '" + $PSCommandPath.Replace("'","''") + "' -RuntimeZip '" + $bundle.Replace("'","''") + "' -Sha256 '" + $Sha256.ToLowerInvariant() + "' -Apply") }
    $receipt.relaunchCommand += " -Python '" + $(if ($Python) { $Python.Replace("'","''") } else { '<existing-python.exe>' }) + "'"
    if ($Apply) { $ownsGuard = $true }; Phase 'staging'
    if ($RuntimeZip) {
        $source = Plain-Path $RuntimeZip
        if (!(Test-Path -LiteralPath $source -PathType Leaf) -or (Get-Item -LiteralPath $source).Length -gt $limit) { throw 'Local ZIP is unavailable or exceeds its budget.' }
        $readStream = [IO.File]::Open($source,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
        $writeStream = [IO.File]::Open($bundle,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try { if ($readStream.Length -gt $limit) { throw 'Local ZIP exceeds its budget.' }; $readStream.CopyTo($writeStream,65536) } finally { $writeStream.Dispose(); $readStream.Dispose() }
    } else { Download-Bundle $bundle }
    if ((Get-Item -LiteralPath $bundle).Length -gt $limit -or (Get-FileHash -LiteralPath $bundle -Algorithm SHA256).Hash -ne $Sha256) { throw 'Runtime package SHA256 did not match.' }
    $payload = Join-Path $stage 'payload'; [IO.Directory]::CreateDirectory($payload) | Out-Null; Extract-Bundle $bundle $payload
    Required-Runtime $payload (Join-Path $payload 'desktop'); Phase 'staged'
    if (!$Apply) { $receipt | ConvertTo-Json -Depth 12; return }
    Phase 'preflight'
    $previewPath = Join-Path $repository '.task/preview-session.json'; $original = Read-Json $previewPath; $identity = Owned-Hub $original
    $receipt.originalHub = $identity
    $keyPath = Plain-Path ([string]$original.ViewerKeyFile) -Inside
    if ([IO.Path]::GetFileName($keyPath) -ne 'VIEWER-KEY.txt' -or (Split-Path -Parent $keyPath) -ne (Split-Path -Parent (Split-Path -Parent $identity.Entry)) -or (Get-Item -LiteralPath $keyPath).Length -gt 1024) { throw 'Original private viewer-key custody differs.' }
    $key = [IO.File]::ReadAllText($keyPath).Trim(); if ($key -notmatch '^[A-Za-z0-9_-]{20,256}$') { throw 'Original private viewer key is malformed.' }
    $handler = [Net.Http.HttpClientHandler]::new(); $handler.AllowAutoRedirect = $false; $handler.UseProxy = $false
    $http = [Net.Http.HttpClient]::new($handler); $http.BaseAddress = [uri]$identity.Url; $http.Timeout = [TimeSpan]::FromSeconds(5)
    $http.DefaultRequestHeaders.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer',$key); $key = $null
    $receipt.persistedManagedSessions = Persisted-Sessions $identity.Data
    $receipt.inspectedManagedSessions = Quiescent-Sessions
    Required-Runtime $serverTarget $desktopTarget; $null = @(Runtime-Files $serverTarget); $null = @(Runtime-Files $desktopTarget)
    $desktopReceipt = Join-Path $repository '.task/desktop/session.json'; $desktopState = $null
    if (Test-Path -LiteralPath $desktopReceipt) {
        $desktopState = Read-Json $desktopReceipt; $entry = Plain-Path ([string]$desktopState.Entry) -Inside; $desktopProfile = Plain-Path ([string]$desktopState.Data) -Inside
        if ($desktopProfile -ne (Join-Path $repository '.task/desktop/profile') -or !$entry.StartsWith((Join-Path $repository '.task/desktop/builds/'),[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($entry) -ne 'AgenticView.Desktop.exe' -or ([uri]$desktopState.Url).AbsoluteUri -ne $identity.Url) { throw 'Existing desktop installation identity differs.' }
        $window = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$desktopState.ProcessId)
        if (!$window -or $window.ExecutablePath -ne $entry -or !$window.CommandLine -or !$window.CommandLine.Contains('"' + $desktopProfile + '"') -or !(Same-Start $window.CreationDate ([datetime]$desktopState.CreatedUtc))) { throw 'Existing desktop custody needs inspection; no new window will be created.' }
        $competing = @(Get-CimInstance Win32_Process -Filter "Name='AgenticView.Desktop.exe'" | Where-Object { $_.ProcessId -ne $window.ProcessId -and $_.CommandLine -and $_.CommandLine.Contains('"' + $desktopProfile + '"') })
        if ($competing.Count) { throw 'Competing desktop profile ownership requires inspection.' }
        $receipt.originalDesktop = @{ ProcessId=$window.ProcessId; Executable=$entry; CreatedUtc=$desktopState.CreatedUtc; Profile=$desktopProfile; Url=$desktopState.Url }
    }
    $installServer = Join-Path $stage 'install/server'; $installDesktop = Join-Path $stage 'install/desktop'
    foreach ($file in @(Runtime-Files $payload)) {
        $relative = $file.Substring($payload.Length + 1); $desktop = $relative.Replace('\','/').StartsWith('desktop/',[StringComparison]::OrdinalIgnoreCase)
        $destination = if ($desktop) { Join-Path $installDesktop $relative.Substring(8) } else { Join-Path $installServer $relative }
        $null = Plain-Path $destination -Inside; [IO.Directory]::CreateDirectory((Split-Path -Parent $destination)) | Out-Null; Copy-Item -LiteralPath $file -Destination $destination
    }
    Required-Runtime $installServer $installDesktop
    if ((Owned-Hub $original).CreatedUtc -ne $identity.CreatedUtc) { throw 'Original hub changed during preflight.' }; $null = Persisted-Sessions $identity.Data; $null = Quiescent-Sessions
    [IO.Directory]::CreateDirectory($receipt.backup) | Out-Null; Phase 'installing-outputs'
    foreach ($pair in @(@($serverTarget,(Join-Path $receipt.backup 'server')),@($desktopTarget,(Join-Path $receipt.backup 'desktop')))) {
        $null = Plain-Path $pair[0] -Inside; $null = Plain-Path $pair[1] -Inside; Move-Item -LiteralPath $pair[0] -Destination $pair[1]
    }
    Move-Item -LiteralPath $installServer -Destination $serverTarget; Move-Item -LiteralPath $installDesktop -Destination $desktopTarget
    Phase 'starting-hub'
    $starter = Plain-Path (Join-Path $PSScriptRoot 'start-preview.ps1') -Inside
    & $starter -Replace -Port ([uri]$identity.Url).Port | Out-Null
    $accepted = Read-Json $previewPath; $receipt.newHub = Owned-Hub $accepted
    if ((Get-FileHash -LiteralPath $receipt.newHub.Entry).Hash -ne (Get-FileHash -LiteralPath (Join-Path $payload 'AgenticView.Server.dll')).Hash) { throw 'New hub runtime identity differs from the staged package.' }
    Phase 'hub-ready'
    if ($desktopState) { Phase 'restarting-owned-desktop'; & (Plain-Path (Join-Path $PSScriptRoot 'start-desktop.ps1') -Inside) -Replace -Url $identity.Url | Out-Null; $receipt.desktop = 'restarted with existing profile' }
    Phase 'complete'; $receipt | ConvertTo-Json -Depth 12
} catch {
    if ($receipt) { $receipt.error = $(if ($stopReason) { $stopReason } else { 'Stopped during ' + $receipt.phase + '.' }) + ' Retain receipts, backups and current data; inspect before another Apply. No database rollback or startup retry was attempted.'; try { Phase 'blocked' } catch { }; $receipt | ConvertTo-Json -Depth 12 }
    else { @{phase='blocked';message='Update preflight could not establish custody. Existing installation retained; inspect prior update receipts.'} | ConvertTo-Json }
    exit 1
} finally { if ($http) { $http.Dispose() }; if ($applyLock) { $applyLock.Dispose() } }
