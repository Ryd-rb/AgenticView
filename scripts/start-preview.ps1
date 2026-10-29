[CmdletBinding()]
param([string]$Source = 'dist/server', [int]$Port = 4317, [switch]$Replace)
$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $repository $Source))
if (!$sourceRoot.StartsWith($repository + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Preview source must be inside this checkout.' }
if ($Port -lt 1 -or $Port -gt 65535) { throw 'Invalid preview port.' }
function Assert-PlainPath([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    if (!$cursor.StartsWith($repository + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Preview path escaped the checkout.' }
    while ($cursor -and $cursor -ne $repository) {
        if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Preview paths cannot contain links.' }
        $cursor = Split-Path -Parent $cursor
    }
}
function Same-Start([datetime]$Actual, [datetime]$Saved) {
    return $Actual.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.ffffffZ') -ceq $Saved.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.ffffffZ')
}
function Assert-Listener([int]$ProcessId) {
    $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    if (!$listeners.Count -or @($listeners | Where-Object OwningProcess -ne $ProcessId).Count) { throw 'Preview listener does not belong to the recorded process.' }
}
function Write-Relaunch([string]$Path,[string]$Application) {
    Assert-PlainPath $Path; Assert-PlainPath $Application
    if ([IO.Path]::GetFileName($Path) -ne 'launch.ps1' -or (Split-Path -Parent $Path) -ne (Split-Path -Parent $Application)) { throw 'Preview relaunch custody differs from its stage.' }
    $starter = Join-Path $repository 'scripts/start-preview.ps1'
    $relative = $Application.Substring($repository.Length + 1)
    $command = "& '" + $starter.Replace("'","''") + "' -Source '" + $relative.Replace("'","''") + "' -Port " + $Port + ' -Replace'
    [IO.File]::WriteAllText($Path,('$ErrorActionPreference=''Stop'''+[Environment]::NewLine+$command),[Text.UTF8Encoding]::new($false))
}
function Plain-Files([string]$Directory) {
    if ((Get-Item -LiteralPath $Directory).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Preview input cannot contain links.' }
    foreach ($item in Get-ChildItem -LiteralPath $Directory -Force) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Preview input cannot contain links.' }
        if ($item.PSIsContainer) { Plain-Files $item.FullName } else { $item.FullName }
    }
}
Assert-PlainPath $sourceRoot
$files = @(Plain-Files $sourceRoot | Sort-Object)
if (!(Test-Path -LiteralPath (Join-Path $sourceRoot 'AgenticView.Server.dll')) -or !(Test-Path -LiteralPath (Join-Path $sourceRoot 'wwwroot/index.html'))) { throw 'Build and validate the application before staging a preview.' }
$identity = ($files | ForEach-Object { $_.Substring($sourceRoot.Length + 1) + ':' + (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash }) -join "`n"
$algorithm = [Security.Cryptography.SHA256]::Create()
try { $buildHash = [BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($identity))).Replace('-','').ToLowerInvariant() } finally { $algorithm.Dispose() }
$statePath = Join-Path $repository '.task/preview-session.json'
$url = 'http://127.0.0.1:' + $Port
$dotnet = (Get-Command dotnet).Source
Assert-PlainPath $sourceRoot; Assert-PlainPath $statePath
[IO.Directory]::CreateDirectory((Split-Path -Parent $statePath)) | Out-Null
$launchLock = [IO.File]::Open((Join-Path $repository '.task/preview-launcher.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try {
$previousData = $null
if (Test-Path -LiteralPath $statePath) {
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    if ($state.Phase -in @('launch-intent','starting','launch-uncertain','termination-uncertain')) { throw 'Previous preview startup is uncertain. Inspect the retained receipt and process before retrying.' }
    $existing = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$state.ProcessId)
    $previewBoundary = [IO.Path]::GetFullPath((Join-Path $repository '.task/preview')) + [IO.Path]::DirectorySeparatorChar
    if (![IO.Path]::GetFullPath([string]$state.Entry).StartsWith($previewBoundary,[StringComparison]::OrdinalIgnoreCase) -or ![IO.Path]::GetFullPath([string]$state.Data).StartsWith($previewBoundary,[StringComparison]::OrdinalIgnoreCase)) { throw 'Existing preview custody could not be established.' }
    Assert-PlainPath ([string]$state.Entry); Assert-PlainPath ([string]$state.Data)
    if ($existing -and (!$existing.CommandLine -or !$existing.CommandLine.Contains([string]$state.Entry) -or $existing.ExecutablePath -ne $dotnet -or ($state.CreatedUtc -and !(Same-Start $existing.CreationDate ([datetime]$state.CreatedUtc))))) { throw 'The recorded preview PID belongs to another process; retained state was not touched.' }
    if ($Replace) {
        # A prior failed replacement can leave a stopped process and intact data. Keep that data.
        $previousData = [IO.Path]::GetFullPath([string]$state.Data)
        $null = @(Plain-Files $previousData)
    }
    if ($existing -and $existing.CommandLine -and $existing.CommandLine.Contains([string]$state.Entry)) {
        if ($state.BuildHash -eq $buildHash -and $state.Url -eq $url) {
            Assert-Listener ([int]$state.ProcessId)
            $state | Add-Member -Force -NotePropertyName CreatedUtc -NotePropertyValue $existing.CreationDate.ToUniversalTime().ToString('O')
            $state | Add-Member -Force -NotePropertyName Executable -NotePropertyValue $dotnet
            $state | Add-Member -Force -NotePropertyName Phase -NotePropertyValue 'ready'
            Write-Relaunch ([string]$state.Relaunch) (Split-Path -Parent ([string]$state.Entry))
            [IO.File]::WriteAllText($statePath,($state | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
            $state | ConvertTo-Json -Compress; return
        }
        if (!$Replace) { throw 'An isolated preview of another build is still running. Use -Replace to update this owned preview while preserving its data.' }
        $previewBoundary = [IO.Path]::GetFullPath((Join-Path $repository '.task/preview')) + [IO.Path]::DirectorySeparatorChar
        if (![IO.Path]::GetFullPath([string]$state.Entry).StartsWith($previewBoundary,[StringComparison]::OrdinalIgnoreCase) -or ![IO.Path]::GetFullPath([string]$state.Data).StartsWith($previewBoundary,[StringComparison]::OrdinalIgnoreCase)) { throw 'Existing preview custody could not be established.' }
        $previousData = [IO.Path]::GetFullPath([string]$state.Data)
        $null = @(Plain-Files $previousData)
        Stop-Process -Id ([int]$state.ProcessId)
        Wait-Process -Id ([int]$state.ProcessId) -Timeout 15 -ErrorAction SilentlyContinue
        $still = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$state.ProcessId)
        if ($still -and $still.CommandLine -and $still.CommandLine.Contains([string]$state.Entry)) { throw 'The previous preview did not exit. Latest data was retained; no replacement was launched.' }
    }
}
$occupied = $true
for ($attempt=0; $attempt -lt $(if ($previousData) { 30 } else { 1 }); $attempt++) {
    $probe = [Net.Sockets.TcpClient]::new()
    try { $occupied = $probe.ConnectAsync('127.0.0.1',$Port).Wait(150) } catch [AggregateException] { $occupied = $false } finally { $probe.Dispose() }
    if (!$occupied) { break }
    if ($previousData) { Start-Sleep -Milliseconds 100 }
}
if ($occupied) { throw 'Preview port is already occupied. Existing data was retained.' }
$stage = Join-Path $repository ('.task/preview/' + [Guid]::NewGuid().ToString('N'))
$application = Join-Path $stage 'app'
[IO.Directory]::CreateDirectory($application) | Out-Null
foreach ($file in $files) { $destination = Join-Path $application $file.Substring($sourceRoot.Length + 1); [IO.Directory]::CreateDirectory((Split-Path -Parent $destination)) | Out-Null; Copy-Item -LiteralPath $file -Destination $destination }
$entry = Join-Path $application 'AgenticView.Server.dll'
$data = Join-Path $stage 'data'
if ($previousData) {
    foreach ($file in @(Plain-Files $previousData)) { $destination = Join-Path $data $file.Substring($previousData.Length + 1); [IO.Directory]::CreateDirectory((Split-Path -Parent $destination)) | Out-Null; Copy-Item -LiteralPath $file -Destination $destination }
}
$viewerFile = Join-Path $stage 'VIEWER-KEY.txt'
$relaunch = Join-Path $stage 'launch.ps1'
$receipt = [ordered]@{ ProcessId=0; Entry=$entry; Executable=$dotnet; CreatedUtc=$null; BuildHash=$buildHash; Url=$url; ViewerKeyFile=$viewerFile; Relaunch=$relaunch; Data=$data; Phase='launch-intent' }
function Save-Receipt {
    $json = $receipt | ConvertTo-Json
    [IO.File]::WriteAllText((Join-Path $stage 'session.json'),$json,[Text.UTF8Encoding]::new($false))
    [IO.File]::WriteAllText($statePath,$json,[Text.UTF8Encoding]::new($false))
}
# Retain exact launch intent before Process.Start; no older database is restored after traffic.
if ($state) { [IO.File]::WriteAllText((Join-Path $stage 'previous-session.json'),($state | ConvertTo-Json),[Text.UTF8Encoding]::new($false)) }
Save-Receipt
$process = $null
try {
$previous = @{}
foreach ($name in @('AV_DATA_DIR','AV_HOST','AV_PORT','AV_PUBLIC_URL','AV_WEB_ROOT')) { $previous[$name] = [Environment]::GetEnvironmentVariable($name,'Process') }
try {
    $env:AV_DATA_DIR = $data; $env:AV_HOST = '127.0.0.1'; $env:AV_PORT = [string]$Port; $env:AV_PUBLIC_URL = $url; $env:AV_WEB_ROOT = Join-Path $application 'wwwroot'
    $process = Start-Process -FilePath $dotnet -ArgumentList ('"' + $entry + '"') -WorkingDirectory $stage -WindowStyle Hidden -RedirectStandardOutput (Join-Path $stage 'stdout.log') -RedirectStandardError (Join-Path $stage 'stderr.log') -PassThru
} finally { foreach ($name in $previous.Keys) { [Environment]::SetEnvironmentVariable($name,$previous[$name],'Process') } }
$receipt.ProcessId = $process.Id; $receipt.CreatedUtc = $process.StartTime.ToUniversalTime().ToString('O'); $receipt.Phase = 'starting'; Save-Receipt
$ready = $false
for ($attempt=0; $attempt -lt 50; $attempt++) { try { if ((Invoke-RestMethod -Uri ($url + '/health') -TimeoutSec 1).runtime -eq '.NET 10') { $ready=$true; break } } catch { }; Start-Sleep -Milliseconds 200 }
if (!$ready) { throw 'Preview startup failed. Its isolated data and logs were retained.' }
$process.Refresh()
if ($process.HasExited) { throw 'The staged preview process exited. Its data and logs were retained.' }
$native = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $process.Id)
if (!$native -or $native.ExecutablePath -ne $dotnet -or !$native.CommandLine -or !$native.CommandLine.Contains($entry) -or !(Same-Start $native.CreationDate ([datetime]$receipt.CreatedUtc))) { throw 'New preview process custody could not be established.' }
Assert-Listener $process.Id
$credentials = Get-Content -LiteralPath (Join-Path $data 'credentials.json') -Raw | ConvertFrom-Json
[IO.File]::WriteAllText($viewerFile,$credentials.viewerToken,[Text.UTF8Encoding]::new($false))
Write-Relaunch $relaunch $application
$receipt.Phase = 'ready'; Save-Receipt
$receipt | ConvertTo-Json -Compress
} catch {
    $settled = $false
    if ($process) {
        try {
            $process.Refresh()
            if ($process.HasExited) { $settled = $true }
            else {
                $native = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $process.Id)
                if ($native -and $native.ExecutablePath -eq $dotnet -and $native.CommandLine -and $native.CommandLine.Contains($entry) -and (!$receipt.CreatedUtc -or (Same-Start $native.CreationDate ([datetime]$receipt.CreatedUtc)))) {
                    Stop-Process -Id $process.Id -ErrorAction Stop
                    Wait-Process -Id $process.Id -Timeout 5 -ErrorAction SilentlyContinue
                    $process.Refresh(); $settled = $process.HasExited
                }
            }
        } catch { }
    }
    $receipt.Phase = if ($settled) { 'failed' } elseif ($process) { 'termination-uncertain' } else { 'launch-uncertain' }
    Save-Receipt
    throw 'Preview startup failed. The latest data, logs and process receipt were retained; no database rollback was attempted.'
}
} finally { $launchLock.Dispose() }
