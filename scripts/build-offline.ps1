[CmdletBinding()]
param([string]$CacheRoot = [IO.Path]::GetTempPath(), [switch]$ServerOnly)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$bundleRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
if (-not (Test-Path -LiteralPath (Join-Path $bundleRoot 'NuGet.offline.config') -PathType Leaf)) {
    throw 'Run the copy of scripts/build-offline.ps1 inside an extracted offline source bundle.'
}

function Assert-BundlePath([string]$Path) {
    $resolved = [IO.Path]::GetFullPath($Path)
    if ($resolved -ne $bundleRoot -and -not $resolved.StartsWith($bundleRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Path escaped the offline bundle.' }
    $cursor = $resolved
    while ($cursor.Length -ge $bundleRoot.Length) {
        if (Test-Path -LiteralPath $cursor) {
            if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Links and reparse points are not allowed in the offline build.' }
        }
        if ($cursor -eq $bundleRoot) { break }
        $cursor = Split-Path -Parent $cursor
    }
    return $resolved
}

if (-not (Get-Command dotnet -ErrorAction SilentlyContinue)) { throw 'Install the .NET 10 SDK before building. This script does not install software.' }
$sdkVersion = (& dotnet --version).Trim()
if ($LASTEXITCODE -ne 0 -or $sdkVersion -notmatch '^10\.') { throw 'The bundle requires the .NET 10 SDK.' }
$manifestPath = Assert-BundlePath (Join-Path $bundleRoot 'bundle-manifest.json')
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
foreach ($file in $manifest.files) {
    $relative = [string]$file.path
    if ([IO.Path]::IsPathRooted($relative) -or $relative -match '(^|[\\/])\.\.([\\/]|$)') { throw 'Invalid relative manifest path.' }
    $source = Assert-BundlePath (Join-Path $bundleRoot $relative)
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "Missing bundle file: $relative" }
    if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) { throw "Bundle integrity check failed: $relative" }
}

$feed = Assert-BundlePath (Join-Path $bundleRoot 'offline/nuget')
if (-not (Test-Path -LiteralPath $feed -PathType Container)) { throw 'The local NuGet feed is missing.' }
$temporaryRoot = [IO.Path]::GetFullPath($CacheRoot)
if ($temporaryRoot.StartsWith('\\')) { throw 'CacheRoot must be local, not a network share.' }
if ($temporaryRoot.Length -gt [IO.Path]::GetPathRoot($temporaryRoot).Length) { $temporaryRoot = $temporaryRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) }
if (-not (Test-Path -LiteralPath $temporaryRoot -PathType Container)) { throw 'CacheRoot must be an existing short local directory.' }
# Check every existing ancestor, rather than trusting a TEMP path containing a link.
$cursor = $temporaryRoot
while ($cursor) {
    if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Links and reparse points are not allowed in the restore cache path.' }
    $parent = Split-Path -Parent $cursor
    if ($parent -eq $cursor) { break }
    $cursor = $parent
}
$buildId = [Guid]::NewGuid().ToString('N')
$cache = [IO.Path]::GetFullPath((Join-Path $temporaryRoot ('av-' + $buildId.Substring(0, 16))))
if (-not $cache.StartsWith($temporaryRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Cache path escaped CacheRoot.' }
if ($cache.Length -gt 100) { throw 'The restore cache path is too long. Pass -CacheRoot with an existing shorter local directory; no Windows configuration change is needed.' }
if (Test-Path -LiteralPath $cache) { throw 'Expected a new, empty restore cache.' }
$application = Assert-BundlePath (Join-Path $bundleRoot 'app')
if (Test-Path -LiteralPath $application) { throw 'The app output already exists. Preserve or rename that directory before another build.' }
[IO.Directory]::CreateDirectory($cache) | Out-Null
$diagnosticRoot = Assert-BundlePath (Join-Path $bundleRoot '.offline-build')
[IO.Directory]::CreateDirectory($diagnosticRoot) | Out-Null
$diagnosticPath = Assert-BundlePath (Join-Path $diagnosticRoot ($buildId + '.json'))
if (Test-Path -LiteralPath $diagnosticPath) { throw 'Build diagnostic record already exists.' }
$diagnostic = [ordered]@{ format = 1; sdk = $sdkVersion; cacheDirectory = $cache; status = 'started'; output = 'app' }
[IO.File]::WriteAllText($diagnosticPath, ($diagnostic | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
Write-Host "Retained temporary restore cache: $cache"
Write-Host "Local build record: $diagnosticPath"
$project = Assert-BundlePath (Join-Path $bundleRoot 'src/AgenticView.Server/AgenticView.Server.csproj')
$configuration = Assert-BundlePath (Join-Path $bundleRoot 'NuGet.offline.config')
$previousEnvironment = @{}
foreach ($name in @('NUGET_PACKAGES', 'NUGET_FALLBACK_PACKAGES', 'NUGET_HTTP_CACHE_PATH', 'NUGET_CERT_REVOCATION_MODE', 'DOTNET_CLI_TELEMETRY_OPTOUT', 'DOTNET_SKIP_FIRST_TIME_EXPERIENCE')) { $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
try {
    $env:NUGET_PACKAGES = Join-Path $cache 'p'
    $env:NUGET_FALLBACK_PACKAGES = ''
    $env:NUGET_HTTP_CACHE_PATH = Join-Path $cache 'http'
    $env:NUGET_CERT_REVOCATION_MODE = 'offline'
    $env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
    $env:DOTNET_SKIP_FIRST_TIME_EXPERIENCE = '1'
    Push-Location -LiteralPath $bundleRoot
    try {
        & dotnet restore $project --configfile $configuration --packages $env:NUGET_PACKAGES --locked-mode --no-http-cache '-p:NuGetAudit=false' '-p:RestoreIgnoreFailedSources=false' "-p:RestoreSources=$feed" '-p:RestoreFallbackFolders=' '-p:RestoreAdditionalProjectSources=' '-p:RestoreAdditionalProjectFallbackFolders=' '-p:UseAppHost=false'
        if ($LASTEXITCODE -ne 0) { throw 'Offline locked restore failed. The cache and diagnostics were retained.' }
        & dotnet publish $project --no-restore --no-self-contained --configuration Release --output $application '-p:NuGetAudit=false' '-p:UseAppHost=false'
        if ($LASTEXITCODE -ne 0) { throw 'Offline publish failed. Sources, cache and any partial output were retained.' }
        if (!$ServerOnly -and $env:OS -eq 'Windows_NT') {
            $desktopProject = Assert-BundlePath (Join-Path $bundleRoot 'src/AgenticView.Desktop/AgenticView.Desktop.csproj')
            $desktopOutput = Assert-BundlePath (Join-Path $application 'desktop')
            & dotnet restore $desktopProject --configfile $configuration --packages $env:NUGET_PACKAGES --locked-mode --no-http-cache '-p:NuGetAudit=false' '-p:RestoreIgnoreFailedSources=false' "-p:RestoreSources=$feed" '-p:RestoreFallbackFolders=' '-p:RestoreAdditionalProjectSources=' '-p:RestoreAdditionalProjectFallbackFolders='
            if ($LASTEXITCODE -ne 0) { throw 'Offline desktop restore failed. Sources, cache and diagnostics retained.' }
            & dotnet publish $desktopProject --no-restore --no-self-contained --configuration Release --output $desktopOutput '-p:NuGetAudit=false'
            if ($LASTEXITCODE -ne 0) { throw 'Offline desktop publish failed. Sources, cache and diagnostics retained.' }
            $diagnostic['desktop'] = 'app/desktop/AgenticView.Desktop.exe'
        }
        $diagnostic.status = 'succeeded'
    } finally { Pop-Location }
} catch {
    $diagnostic.status = 'failed'
    throw
} finally {
    foreach ($name in $previousEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process') }
    [IO.File]::WriteAllText($diagnosticPath, ($diagnostic | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
}
Write-Host "Built with .NET SDK $sdkVersion. Run: dotnet app/AgenticView.Server.dll"
Write-Host 'No Node.js, npm or online package source is used by this build.'
