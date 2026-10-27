[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repository = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$root = (& git -C $repository rev-parse --show-toplevel).Trim()
if ($LASTEXITCODE -ne 0 -or [IO.Path]::GetFullPath($root) -ne $repository) { throw 'Workspace identity could not be verified.' }
if (@(& git -C $repository status --porcelain).Count -ne 0) { throw 'Commit intended source changes before completion.' }
$head = (& git -C $repository rev-parse HEAD).Trim()
$remote = ((& git -C $repository ls-remote --heads origin main) -split '\s+')[0]
if ($LASTEXITCODE -ne 0 -or $remote -ne $head) { throw 'The integrated main branch does not match this source.' }
$removed = @()
$record = [ordered]@{head=$head;integrated=$true;removed=$removed;retained=@('server build and symbols','offline source bundles and empty-cache build evidence','benchmark evidence','isolated preview and its private data','development dependencies','superseded private prototype evidence');reason='The active preview and verification evidence keep this managed worktree in use. No broad ignored-file cleanup is authorized.'}
[IO.Directory]::CreateDirectory((Join-Path $repository '.task')) | Out-Null
[IO.File]::WriteAllText((Join-Path $repository '.task/completion.json'),($record | ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
if (@(& git -C $repository status --porcelain).Count -ne 0) { throw 'Completion left unexpected source changes.' }
$record | ConvertTo-Json -Compress
