[CmdletBinding()]
param([string]$Source='dist/desktop',[string]$Url='http://127.0.0.1:4318/',[Parameter(Mandatory)][string]$ViewerKeyFile,[ValidateRange(1,7200)][int]$LifetimeSeconds=600,[switch]$TestRendererUnavailable)
$ErrorActionPreference='Stop'
# Explicit finite diagnostic host. This never shows, restores or replaces a window.
$repository=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot));$boundary=$repository+[IO.Path]::DirectorySeparatorChar
function Assert-Plain([string]$Path){
 $full=[IO.Path]::GetFullPath($Path);if(!$full.StartsWith($boundary,[StringComparison]::OrdinalIgnoreCase)){throw 'Test host paths must stay inside this checkout.'}
 for($cursor=$full;$cursor -and $cursor -ne $repository;$cursor=Split-Path -Parent $cursor){if((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Test host paths cannot use links.'}}
}
$sourceRoot=[IO.Path]::GetFullPath((Join-Path $repository $Source));Assert-Plain $sourceRoot;Assert-Plain $ViewerKeyFile
$parsed=$null;if(![Uri]::TryCreate($Url,[UriKind]::Absolute,[ref]$parsed) -or !$parsed.IsLoopback -or $parsed.UserInfo -or $parsed.Query -or $parsed.Fragment -or $parsed.Scheme -notin @('http','https')){throw 'Test bootstrap requires a loopback URL without credentials/query/fragment.'}
if(!(Test-Path -LiteralPath $ViewerKeyFile -PathType Leaf)){throw 'Private viewer-key file is missing.'}
$files=@(Get-ChildItem -LiteralPath $sourceRoot -Recurse -File -Force);foreach($file in $files){Assert-Plain $file.FullName}
if(!$files.Count -or !(Test-Path -LiteralPath (Join-Path $sourceRoot 'AgenticView.Desktop.exe'))){throw 'Publish the desktop app first.'}
$stage=Join-Path $repository ('.task/desktop-tests/'+[guid]::NewGuid().ToString('N'));Assert-Plain $stage
New-Item -ItemType Directory -Path (Join-Path $stage 'app') -Force|Out-Null
foreach($file in $files){$relative=[IO.Path]::GetRelativePath($sourceRoot,$file.FullName);$target=Join-Path (Join-Path $stage 'app') $relative;Assert-Plain $target;New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force|Out-Null;Copy-Item -LiteralPath $file.FullName -Destination $target}
$entry=Join-Path $stage 'app/AgenticView.Desktop.exe';$data=Join-Path $stage 'profile';$arguments='--url "'+$parsed.AbsoluteUri+'" --data-dir "'+$data+'" --viewer-key-file "'+[IO.Path]::GetFullPath($ViewerKeyFile)+'" --windowed --background-test-host '+$LifetimeSeconds
if($TestRendererUnavailable){$arguments+=' --test-renderer-unavailable'}
$process=Start-Process -FilePath $entry -ArgumentList $arguments -WorkingDirectory (Join-Path $stage 'app') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $stage 'stdout.log') -RedirectStandardError (Join-Path $stage 'stderr.log') -PassThru
$native=Get-CimInstance Win32_Process -Filter ('ProcessId='+$process.Id);if(!$native -or $native.ExecutablePath -ne $entry){throw 'Test host process custody failed.'}
$receipt=@{ProcessId=$native.ProcessId;Entry=$entry;CreatedUtc=$native.CreationDate.ToUniversalTime().ToString('o');LifetimeSeconds=$LifetimeSeconds;Url=$parsed.AbsoluteUri;Data=$data;Stage=$stage;BuildHash=(Get-FileHash -LiteralPath (Join-Path $stage 'app/AgenticView.Desktop.dll')).Hash;Mode='finite-hidden-test-host';TestRendererUnavailable=[bool]$TestRendererUnavailable}
$receipt|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $stage 'session.json');$receipt|ConvertTo-Json -Compress
