[CmdletBinding()]
param([string]$NuGetPackages = $env:NUGET_PACKAGES)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
if (-not $NuGetPackages) { $NuGetPackages = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.nuget/packages' }
$NuGetPackages = [IO.Path]::GetFullPath($NuGetPackages)

function Assert-PlainPath([string]$Path, [string]$Boundary) {
    $resolved = [IO.Path]::GetFullPath($Path)
    $boundaryPath = [IO.Path]::GetFullPath($Boundary).TrimEnd([IO.Path]::DirectorySeparatorChar)
    if ($resolved -ne $boundaryPath -and -not $resolved.StartsWith($boundaryPath + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Path escaped its allowed boundary.' }
    $cursor = $resolved
    while ($cursor.Length -ge $boundaryPath.Length) {
        if (Test-Path -LiteralPath $cursor) {
            if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Links and reparse points cannot enter the offline bundle.' }
        }
        if ($cursor -eq $boundaryPath) { break }
        $cursor = Split-Path -Parent $cursor
    }
    return $resolved
}
function Enumerate-PlainFiles([string]$Directory, [string]$Boundary) {
    $directoryPath = Assert-PlainPath $Directory $Boundary
    foreach ($item in Get-ChildItem -LiteralPath $directoryPath -Force | Sort-Object Name) {
        $itemPath = Assert-PlainPath $item.FullName $Boundary
        if ($item.PSIsContainer) { Enumerate-PlainFiles $itemPath $Boundary } else { $itemPath }
    }
}

$webRoot = Assert-PlainPath (Join-Path $repository 'dist/web') $repository
if (-not (Test-Path -LiteralPath (Join-Path $webRoot 'index.html') -PathType Leaf)) { throw 'Missing prebuilt dist/web/index.html. Build the web application on the connected preparation machine first.' }
$webFiles = @(Enumerate-PlainFiles $webRoot $repository)
if (-not ($webFiles | Where-Object { $_ -like '*.js' })) { throw 'The prebuilt web application has no JavaScript bundle.' }
foreach ($file in $webFiles) { if ([IO.Path]::GetExtension($file) -notin @('.html', '.js', '.css', '.woff', '.woff2', '.ttf', '.svg', '.png', '.ico', '.webp', '.jpg', '.jpeg')) { throw 'Unexpected file type in the prebuilt web application.' } }

$sourceFiles = @(
    'global.json', 'Directory.Build.props', 'LICENSE', 'README.md', 'shared/components.schema.json', 'shared/application-manifest.schema.json',
    'src/AgenticView.Server/AgenticView.Server.csproj', 'src/AgenticView.Server/packages.lock.json',
    'src/AgenticView.Server/Program.cs', 'src/AgenticView.Server/AppHost.cs', 'src/AgenticView.Server/Configuration.cs',
    'src/AgenticView.Server/McpTools.cs', 'src/AgenticView.Server/Hub.cs', 'src/AgenticView.Server/ComponentValidator.cs', 'src/AgenticView.Server/ControlStore.cs', 'src/AgenticView.Server/ConnectorWorker.cs', 'src/AgenticView.Server/WebhookHandler.cs', 'src/AgenticView.Server/ApplicationStore.cs',
    'src/AgenticView.Server/SessionStore.cs', 'src/AgenticView.Server/SessionRunner.cs', 'src/AgenticView.Server/SessionOutput.cs', 'src/AgenticView.Server/SessionSsh.cs', 'src/AgenticView.Server/SshCredentialStore.cs', 'src/AgenticView.Server/SshAskpass.cs',
    'src/AgenticView.Server/CardStyles.cs',
    'src/AgenticView.Server/OperatorView.cs', 'src/AgenticView.Server/QuickText.cs',
    'src/AgenticView.Server/Demo.cs', 'src/AgenticView.Server/demo.json', 'src/AgenticView.Server/CanvasPacking.cs', 'src/AgenticView.Server/MonitoringState.cs', 'src/AgenticView.Server/WebAssets.cs',
    'src/AgenticView.Desktop/AgenticView.Desktop.csproj', 'src/AgenticView.Desktop/packages.lock.json',
    'src/AgenticView.Desktop/Program.cs', 'src/AgenticView.Desktop/DesktopOptions.cs',
    'src/AgenticView.Desktop/DesktopWindow.cs', 'src/AgenticView.Desktop/BridgePolicy.cs',
    'src/AgenticView.Desktop/BrandIcon.cs',
    'scripts/build-offline.ps1', 'docs/design.md', 'docs/offline-build.md', 'docs/protocol.md', 'docs/performance.md', 'docs/desktop.md', 'docs/native-components.md', 'docs/controls.md', 'docs/applications.md', 'examples/applications/service-console.agenticview.json', 'examples/connector/profile.example.json', 'examples/connector/row-service.py', 'docs/media/agenticview-demo.gif'
    'docs/sessions.md', 'examples/applications/agent-sessions.agenticview.json', 'examples/connector/sessions.example.json'
    'docs/view-management.md'
    'docs/subscription-setup.md', 'examples/applications/agent-sessions-with-subscription.agenticview.json', 'examples/connector/subscription-profile.example.json', 'examples/connector/subscription-connection.ps1'
)
foreach ($relative in $sourceFiles) { $file = Assert-PlainPath (Join-Path $repository $relative) $repository; if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing allowed source file: $relative" } }
$packages = @{}
foreach ($lockPath in @('src/AgenticView.Server/packages.lock.json','src/AgenticView.Desktop/packages.lock.json')) {
$lock = Get-Content -LiteralPath (Join-Path $repository $lockPath) -Raw | ConvertFrom-Json
foreach ($framework in $lock.dependencies.PSObject.Properties) {
    foreach ($dependency in $framework.Value.PSObject.Properties) {
        if ($dependency.Value.type -eq 'Project') { continue }
        $id = $dependency.Name.ToLowerInvariant(); $version = [string]$dependency.Value.resolved
        if ($id -notmatch '^[a-z0-9_.-]+$' -or $version -notmatch '^[a-zA-Z0-9.+-]+$') { throw 'Invalid locked package path.' }
        $key = "$id.$version"
        if ($packages.ContainsKey($key) -and $packages[$key].contentHash -ne $dependency.Value.contentHash) { throw 'Conflicting package hashes across target frameworks.' }
        $packages[$key] = @{ id = $id; version = $version; contentHash = [string]$dependency.Value.contentHash }
    }
}
}
if ($packages.Count -eq 0) { throw 'The lockfile has no resolved packages.' }
foreach ($package in $packages.Values) {
    $directory = Assert-PlainPath (Join-Path $NuGetPackages ($package.id + '/' + $package.version)) $NuGetPackages
    $archive = Assert-PlainPath (Join-Path $directory ($package.id + '.' + $package.version + '.nupkg')) $NuGetPackages
    $metadataPath = Assert-PlainPath (Join-Path $directory '.nupkg.metadata') $NuGetPackages
    $hashPath = Assert-PlainPath ($archive + '.sha512') $NuGetPackages
    foreach ($required in @($archive, $metadataPath, $hashPath)) { if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "Incomplete local cache for package $($package.id) $($package.version). No package download was attempted." } }
    $metadata = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
    if ($metadata.contentHash -ne $package.contentHash) { throw "NuGet lock content hash mismatch: $($package.id)" }
    $algorithm = [Security.Cryptography.SHA512]::Create()
    $stream = [IO.File]::OpenRead($archive)
    try { $rawHash = [Convert]::ToBase64String($algorithm.ComputeHash($stream)) } finally { $stream.Dispose(); $algorithm.Dispose() }
    if ($rawHash -ne (Get-Content -LiteralPath $hashPath -Raw).Trim()) { throw "Package archive SHA512 mismatch: $($package.id)" }
    $package.archive = $archive
}

$outputRoot = Assert-PlainPath (Join-Path $repository '.task/packages') $repository
$name = 'AgenticView-offline-source-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$stage = Assert-PlainPath (Join-Path $outputRoot $name) $repository
$zip = Assert-PlainPath ($stage + '.zip') $repository
if ((Test-Path -LiteralPath $stage) -or (Test-Path -LiteralPath $zip)) { throw 'Package output already exists; no overwrite is allowed.' }
[IO.Directory]::CreateDirectory($stage) | Out-Null
function Copy-AllowedFile([string]$Source, [string]$Relative) {
    $destination = Assert-PlainPath (Join-Path $stage $Relative) $stage
    if (Test-Path -LiteralPath $destination) { throw 'Duplicate bundle destination.' }
    [IO.Directory]::CreateDirectory((Split-Path -Parent $destination)) | Out-Null
    Copy-Item -LiteralPath $Source -Destination $destination
}
foreach ($relative in $sourceFiles) { Copy-AllowedFile (Assert-PlainPath (Join-Path $repository $relative) $repository) $relative }
foreach ($file in $webFiles) { Copy-AllowedFile $file ($file.Substring($repository.Length + 1)) }
foreach ($package in $packages.Values) { Copy-AllowedFile $package.archive ('offline/nuget/' + $package.id + '.' + $package.version + '.nupkg') }
$nugetConfig = @'
<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources><clear /><add key="offline" value="offline/nuget" /></packageSources>
  <fallbackPackageFolders><clear /></fallbackPackageFolders>
  <disabledPackageSources><clear /></disabledPackageSources>
</configuration>
'@
[IO.File]::WriteAllText((Join-Path $stage 'NuGet.offline.config'), $nugetConfig, [Text.UTF8Encoding]::new($false))
$commit = (& git -C $repository rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[a-f0-9]{40,64}$') { throw 'Cannot establish repository source identity.' }
$manifestFiles = @(foreach ($file in Enumerate-PlainFiles $stage $stage) { [ordered]@{ path = $file.Substring($stage.Length + 1).Replace('\', '/'); sha256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant(); bytes = (Get-Item -LiteralPath $file).Length } })
$manifest = [ordered]@{ format = 1; project = 'AgenticView'; sourceCommit = $commit; sourceIdentity = 'The file hashes identify this exact source snapshot; sourceCommit is its repository base, not proof of a clean checkout.'; target = 'Windows x64'; packages = @($packages.Values | Sort-Object id, version | ForEach-Object { [ordered]@{ id = $_.id; version = $_.version; nugetContentHash = $_.contentHash } }); files = $manifestFiles }
[IO.File]::WriteAllText((Join-Path $stage 'bundle-manifest.json'), ($manifest | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory($stage, $zip, [IO.Compression.CompressionLevel]::Optimal, $false)
Write-Host "Created $zip"
Write-Host "Included $($packages.Count) locked NuGet packages and $($manifestFiles.Count) integrity-tracked files. Staging retained at $stage"
[pscustomobject]@{ ZipPath = $zip; StagePath = $stage; PackageCount = $packages.Count }
