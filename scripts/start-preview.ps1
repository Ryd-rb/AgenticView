[CmdletBinding()]
param([string]$Source = 'dist/server', [int]$Port = 4317, [switch]$Replace)
$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $repository $Source))
if (!$sourceRoot.StartsWith($repository + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Preview source must be inside this checkout.' }
if ($Port -lt 1 -or $Port -gt 65535) { throw 'Invalid preview port.' }
function Plain-Files([string]$Directory) {
    if ((Get-Item -LiteralPath $Directory).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Preview input cannot contain links.' }
    foreach ($item in Get-ChildItem -LiteralPath $Directory -Force) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Preview input cannot contain links.' }
        if ($item.PSIsContainer) { Plain-Files $item.FullName } else { $item.FullName }
    }
}
$files = @(Plain-Files $sourceRoot | Sort-Object)
if (!(Test-Path -LiteralPath (Join-Path $sourceRoot 'AgenticView.Server.dll')) -or !(Test-Path -LiteralPath (Join-Path $sourceRoot 'wwwroot/index.html'))) { throw 'Build and validate the application before staging a preview.' }
$identity = ($files | ForEach-Object { $_.Substring($sourceRoot.Length + 1) + ':' + (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash }) -join "`n"
$algorithm = [Security.Cryptography.SHA256]::Create()
try { $buildHash = [BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($identity))).Replace('-','').ToLowerInvariant() } finally { $algorithm.Dispose() }
$statePath = Join-Path $repository '.task/preview-session.json'
$previousData = $null
if (Test-Path -LiteralPath $statePath) {
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    $existing = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$state.ProcessId)
    if ($existing -and $existing.CommandLine -and $existing.CommandLine.Contains([string]$state.Entry)) {
        if ($state.BuildHash -eq $buildHash) { $state | ConvertTo-Json -Compress; return }
        if (!$Replace) { throw 'An isolated preview of another build is still running. Use -Replace to update this owned preview while preserving its data.' }
        $previewBoundary = [IO.Path]::GetFullPath((Join-Path $repository '.task/preview')) + [IO.Path]::DirectorySeparatorChar
        if (![IO.Path]::GetFullPath([string]$state.Entry).StartsWith($previewBoundary,[StringComparison]::OrdinalIgnoreCase) -or ![IO.Path]::GetFullPath([string]$state.Data).StartsWith($previewBoundary,[StringComparison]::OrdinalIgnoreCase)) { throw 'Existing preview custody could not be established.' }
        $previousData = [IO.Path]::GetFullPath([string]$state.Data)
        $null = @(Plain-Files $previousData)
        Stop-Process -Id ([int]$state.ProcessId)
        Wait-Process -Id ([int]$state.ProcessId) -Timeout 15 -ErrorAction SilentlyContinue
    }
}
$probe = [Net.Sockets.TcpClient]::new()
try { if ($probe.ConnectAsync('127.0.0.1',$Port).Wait(150)) { throw 'Preview port is already occupied.' } } catch [AggregateException] { } finally { $probe.Dispose() }
$stage = Join-Path $repository ('.task/preview/' + [Guid]::NewGuid().ToString('N'))
$application = Join-Path $stage 'app'
[IO.Directory]::CreateDirectory($application) | Out-Null
foreach ($file in $files) { $destination = Join-Path $application $file.Substring($sourceRoot.Length + 1); [IO.Directory]::CreateDirectory((Split-Path -Parent $destination)) | Out-Null; Copy-Item -LiteralPath $file -Destination $destination }
$entry = Join-Path $application 'AgenticView.Server.dll'
$data = Join-Path $stage 'data'
if ($previousData) {
    foreach ($file in @(Plain-Files $previousData)) { $destination = Join-Path $data $file.Substring($previousData.Length + 1); [IO.Directory]::CreateDirectory((Split-Path -Parent $destination)) | Out-Null; Copy-Item -LiteralPath $file -Destination $destination }
}
$url = 'http://127.0.0.1:' + $Port
$previous = @{}
foreach ($name in @('AV_DATA_DIR','AV_HOST','AV_PORT','AV_PUBLIC_URL','AV_WEB_ROOT')) { $previous[$name] = [Environment]::GetEnvironmentVariable($name,'Process') }
try {
    $env:AV_DATA_DIR = $data; $env:AV_HOST = '127.0.0.1'; $env:AV_PORT = [string]$Port; $env:AV_PUBLIC_URL = $url; $env:AV_WEB_ROOT = Join-Path $application 'wwwroot'
    $process = Start-Process -FilePath (Get-Command dotnet).Source -ArgumentList ('"' + $entry + '"') -WorkingDirectory $stage -WindowStyle Hidden -RedirectStandardOutput (Join-Path $stage 'stdout.log') -RedirectStandardError (Join-Path $stage 'stderr.log') -PassThru
} finally { foreach ($name in $previous.Keys) { [Environment]::SetEnvironmentVariable($name,$previous[$name],'Process') } }
$ready = $false
for ($attempt=0; $attempt -lt 50; $attempt++) { try { if ((Invoke-RestMethod -Uri ($url + '/health') -TimeoutSec 1).runtime -eq '.NET 10') { $ready=$true; break } } catch { }; Start-Sleep -Milliseconds 200 }
if (!$ready) { throw 'Preview startup failed. Its isolated data and logs were retained.' }
$process.Refresh()
if ($process.HasExited) { throw 'The staged preview process exited. Its data and logs were retained.' }
$credentials = Get-Content -LiteralPath (Join-Path $data 'credentials.json') -Raw | ConvertFrom-Json
$viewerFile = Join-Path $stage 'VIEWER-KEY.txt'
[IO.File]::WriteAllText($viewerFile,$credentials.viewerToken,[Text.UTF8Encoding]::new($false))
$relaunch = Join-Path $stage 'launch.ps1'
$launcher = @'
$ErrorActionPreference='Stop'
$env:AV_DATA_DIR=Join-Path $PSScriptRoot 'data'
$env:AV_HOST='127.0.0.1'
$env:AV_PORT='__PORT__'
$env:AV_PUBLIC_URL='__URL__'
$env:AV_WEB_ROOT=Join-Path $PSScriptRoot 'app/wwwroot'
try { $status=Invoke-RestMethod -Uri '__URL__/health' -TimeoutSec 1; if($status.runtime -eq '.NET 10'){ Write-Host '__URL__ is already running'; return } } catch { }
Set-Location -LiteralPath $PSScriptRoot
& dotnet (Join-Path $PSScriptRoot 'app/AgenticView.Server.dll')
'@
[IO.File]::WriteAllText($relaunch,$launcher.Replace('__PORT__',[string]$Port).Replace('__URL__',$url),[Text.UTF8Encoding]::new($false))
$state = [ordered]@{ ProcessId=$process.Id; Entry=$entry; BuildHash=$buildHash; Url=$url; ViewerKeyFile=$viewerFile; Relaunch=$relaunch; Data=$data }
[IO.File]::WriteAllText($statePath,($state | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
$state | ConvertTo-Json -Compress
