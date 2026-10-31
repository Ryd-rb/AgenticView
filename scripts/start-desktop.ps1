[CmdletBinding()]
param([string]$Source = 'dist/desktop', [string]$Url = 'http://127.0.0.1:4317/', [string]$ViewerKeyFile, [string]$FocusCardId, [switch]$Replace)
$ErrorActionPreference = 'Stop'
$inputTrace = $env:AV_INPUT_TRACE -eq '1'
if($FocusCardId -and ($FocusCardId.Length -gt 100 -or $FocusCardId -cnotmatch '^[a-zA-Z0-9_.:-]+$' -or $FocusCardId -match '[\r\n]' -or $FocusCardId -in @('__proto__','prototype','constructor'))){throw 'Use a bounded focus card identifier.'}
$repository = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$sourceRoot = [IO.Path]::GetFullPath((Join-Path $repository $Source))
$boundary = $repository + [IO.Path]::DirectorySeparatorChar
if (!$sourceRoot.StartsWith($boundary, [StringComparison]::OrdinalIgnoreCase)) { throw 'Desktop source must be inside this checkout.' }
$parsed = $null
if (![Uri]::TryCreate($Url,[UriKind]::Absolute,[ref]$parsed) -or ($parsed.Scheme -ne 'https' -and !($parsed.Scheme -eq 'http' -and $parsed.IsLoopback)) -or $parsed.UserInfo -or $parsed.Query -or $parsed.Fragment) { throw 'Use HTTPS or loopback HTTP without credentials, query or fragment.' }

function Assert-PlainPath([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    if (!$cursor.StartsWith($boundary, [StringComparison]::OrdinalIgnoreCase)) { throw 'Desktop path escaped the checkout.' }
    while ($cursor -and $cursor -ne $repository) {
        if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Desktop paths cannot contain links.' }
        $cursor = Split-Path -Parent $cursor
    }
}
function Plain-Files([string]$Directory) {
    Assert-PlainPath $Directory
    foreach ($item in Get-ChildItem -LiteralPath $Directory -Force) {
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Desktop input cannot contain links.' }
        if ($item.PSIsContainer) { Plain-Files $item.FullName } else { $item.FullName }
    }
}
if ($ViewerKeyFile) {
    if (!$parsed.IsLoopback -or ![IO.Path]::IsPathRooted($ViewerKeyFile) -or $ViewerKeyFile.StartsWith('\\') -or $ViewerKeyFile.IndexOfAny([char[]]'"<>|?*') -ge 0) { throw 'Viewer-key bootstrap requires a plain local file and loopback URL.' }
    Assert-PlainPath $ViewerKeyFile
} elseif ($parsed.IsLoopback) {
    $previewStatePath = Join-Path $repository '.task/preview-session.json'
    Assert-PlainPath $previewStatePath
    if (Test-Path -LiteralPath $previewStatePath -PathType Leaf) {
        $preview = Get-Content -LiteralPath $previewStatePath -Raw | ConvertFrom-Json
        $previewUrl = $null
        if ([Uri]::TryCreate([string]$preview.Url,[UriKind]::Absolute,[ref]$previewUrl) -and $previewUrl.IsLoopback -and $previewUrl.GetLeftPart([UriPartial]::Authority) -eq $parsed.GetLeftPart([UriPartial]::Authority)) {
            $previewBoundary = [IO.Path]::GetFullPath((Join-Path $repository '.task/preview')) + [IO.Path]::DirectorySeparatorChar
            $keyPath = [IO.Path]::GetFullPath([string]$preview.ViewerKeyFile)
            $serverEntry = [IO.Path]::GetFullPath([string]$preview.Entry)
            if (!$keyPath.StartsWith($previewBoundary,[StringComparison]::OrdinalIgnoreCase) -or !$serverEntry.StartsWith($previewBoundary,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($keyPath) -ne 'VIEWER-KEY.txt' -or (Split-Path -Parent $keyPath) -ne (Split-Path -Parent (Split-Path -Parent $serverEntry))) { throw 'Preview key-file custody could not be established.' }
            Assert-PlainPath $keyPath; Assert-PlainPath $serverEntry
            $server = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$preview.ProcessId)
            if (!$server -or !$server.CommandLine -or !$server.CommandLine.Contains('"' + $serverEntry + '"')) { throw 'The recorded loopback preview process is unavailable.' }
            $ViewerKeyFile = $keyPath
        }
    }
}
if ($ViewerKeyFile -and (!(Test-Path -LiteralPath $ViewerKeyFile -PathType Leaf) -or (Get-Item -LiteralPath $ViewerKeyFile).Length -gt 1024)) { throw 'The private viewer-key file must be at most 1 KiB.' }
$files = @(Plain-Files $sourceRoot | Sort-Object)
foreach ($required in @('AgenticView.Desktop.exe','AgenticView.Desktop.dll','AgenticView.Desktop.deps.json','AgenticView.Desktop.runtimeconfig.json')) {
    if (!(Test-Path -LiteralPath (Join-Path $sourceRoot $required) -PathType Leaf)) { throw 'Publish and validate the desktop host before launch.' }
}
$identity = ($files | ForEach-Object { $_.Substring($sourceRoot.Length + 1) + ':' + (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash }) -join "`n"
$algorithm = [Security.Cryptography.SHA256]::Create()
try { $buildHash = [BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($identity))).Replace('-','').ToLowerInvariant() } finally { $algorithm.Dispose() }
$markup = [string](Invoke-WebRequest -Uri $parsed.AbsoluteUri -TimeoutSec 5 -MaximumRedirection 0).Content
$pageIdentity = (@([regex]::Matches($markup, '(?:src|href)="[^"]+"') | ForEach-Object Value | Sort-Object) -join "`n")
if (!$pageIdentity) { throw 'The monitor web assets could not be identified. Existing desktop state was retained.' }
$algorithm = [Security.Cryptography.SHA256]::Create()
try { $pageHash = [BitConverter]::ToString($algorithm.ComputeHash([Text.Encoding]::UTF8.GetBytes($pageIdentity))).Replace('-','').ToLowerInvariant() } finally { $algorithm.Dispose() }
$desktopRoot = Join-Path $repository '.task/desktop'
Assert-PlainPath $desktopRoot
[IO.Directory]::CreateDirectory($desktopRoot) | Out-Null
# Serialize launcher mutations, independently of the native profile's lifetime lock.
$launcherLock = [IO.File]::Open((Join-Path $desktopRoot 'launcher.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try {
    $statePath = Join-Path $desktopRoot 'session.json'
    $data = Join-Path $desktopRoot 'profile'
    Assert-PlainPath $data
    if (Test-Path -LiteralPath $statePath) {
        $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
        $existing = Get-CimInstance Win32_Process -Filter ('ProcessId=' + [int]$state.ProcessId)
        if ($existing) {
            Assert-PlainPath ([string]$state.Entry)
            if ($existing.ExecutablePath -ne [string]$state.Entry -or !$existing.CommandLine -or !$existing.CommandLine.Contains('"' + $data + '"') -or $existing.CreationDate.ToUniversalTime() -ne ([DateTime]$state.CreatedUtc).ToUniversalTime()) { throw 'The previous desktop process identity cannot be established.' }
            if (!$Replace -and $state.BuildHash -eq $buildHash -and $state.Url -eq $parsed.AbsoluteUri -and $state.PageHash -eq $pageHash -and [bool]$state.InputTrace -eq $inputTrace -and [string]$state.FocusCardId -eq $FocusCardId) { $state | ConvertTo-Json -Compress; return }
            if (!$Replace) { throw 'Another owned desktop build is running. Use -Replace to relaunch with the same private profile.' }
            # Only the PID with matching command line, creation time and bounded profile is owned.
            Stop-Process -Id ([int]$state.ProcessId)
            Wait-Process -Id ([int]$state.ProcessId) -Timeout 15 -ErrorAction SilentlyContinue
        }
    }
    $stage = Join-Path $desktopRoot ('builds/' + [guid]::NewGuid().ToString('N'))
    $application = Join-Path $stage 'app'
    [IO.Directory]::CreateDirectory($application) | Out-Null
    foreach ($file in $files) {
        $destination = Join-Path $application $file.Substring($sourceRoot.Length + 1)
        [IO.Directory]::CreateDirectory((Split-Path -Parent $destination)) | Out-Null
        Copy-Item -LiteralPath $file -Destination $destination
    }
    $entry = Join-Path $application 'AgenticView.Desktop.exe'
    $diagnostic = & dotnet (Join-Path $application 'AgenticView.Desktop.dll') --url $parsed.AbsoluteUri --data-dir $data --diagnose
    if ($LASTEXITCODE -ne 0) { throw 'Desktop prerequisite validation failed. Staged build retained.' }
    $diagnostic | Set-Content -LiteralPath (Join-Path $stage 'diagnose.json')
    $health = Invoke-RestMethod -Uri ($parsed.GetLeftPart([UriPartial]::Authority) + '/health') -TimeoutSec 3
    if ($health.runtime -ne '.NET 10') { throw 'Start the isolated AgenticView server before the desktop host.' }
    $arguments = '--url "' + $parsed.AbsoluteUri + '" --data-dir "' + $data + '"'
    if ($ViewerKeyFile) { $arguments += ' --viewer-key-file "' + $ViewerKeyFile + '"' }
    if ($FocusCardId) { $arguments += ' --focus-card "' + $FocusCardId + '"' }
    # A visible interactive desktop window is the purpose of this launcher.
    $process = Start-Process -FilePath $entry -ArgumentList $arguments -WorkingDirectory $stage -WindowStyle Normal -RedirectStandardOutput (Join-Path $stage 'stdout.log') -RedirectStandardError (Join-Path $stage 'stderr.log') -PassThru
    Start-Sleep -Milliseconds 1200
    $process.Refresh()
    if ($process.HasExited) { throw 'The desktop host exited during startup. Private profile and logs retained.' }
    $native = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $process.Id)
    if (!$native) { throw 'Desktop process identity is unavailable; staged state retained.' }
    $relaunch = Join-Path $stage 'launch.ps1'
    $relativeStage = $application.Substring($repository.Length + 1)
    $launcher = '$env:AV_INPUT_TRACE=' + $(if ($inputTrace) { "'1'; " } else { "'0'; " }) + "& '" + (Join-Path $repository 'scripts/start-desktop.ps1').Replace("'","''") + "' -Source '" + $relativeStage.Replace("'","''") + "' -Url '" + $parsed.AbsoluteUri.Replace("'","''") + "' -Replace"
    if ($ViewerKeyFile) { $launcher += " -ViewerKeyFile '" + $ViewerKeyFile.Replace("'","''") + "'" }
    if ($FocusCardId) { $launcher += " -FocusCardId '" + $FocusCardId.Replace("'","''") + "'" }
    [IO.File]::WriteAllText($relaunch,$launcher,[Text.UTF8Encoding]::new($false))
    $state = [ordered]@{ ProcessId=$process.Id; Entry=$entry; CreatedUtc=$native.CreationDate.ToUniversalTime().ToString('O'); BuildHash=$buildHash; PageHash=$pageHash; InputTrace=$inputTrace; Url=$parsed.AbsoluteUri; Data=$data; Relaunch=$relaunch; FocusCardId=$FocusCardId }
    [IO.File]::WriteAllText($statePath,($state | ConvertTo-Json),[Text.UTF8Encoding]::new($false))
    $state | ConvertTo-Json -Compress
} finally { $launcherLock.Dispose() }
