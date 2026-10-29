#Requires -Version 7.2
param([Parameter(Mandatory)][string]$SourceScript)
$ErrorActionPreference='Stop'
$SourceScript=[IO.Path]::GetFullPath($SourceScript)
$global:consoleUpdateCalls=0
function global:Start-Process { $global:consoleUpdateCalls++; throw 'Fixture forbids process launch.' }
function global:Stop-Process { $global:consoleUpdateCalls++; throw 'Fixture forbids process termination.' }
function global:Get-CimInstance { $global:consoleUpdateCalls++; throw 'Fixture forbids live process inspection.' }
function global:Get-NetTCPConnection { $global:consoleUpdateCalls++; throw 'Fixture forbids listener inspection.' }
function global:Invoke-RestMethod { $global:consoleUpdateCalls++; throw 'Fixture forbids network requests.' }
function global:Invoke-WebRequest { $global:consoleUpdateCalls++; throw 'Fixture forbids network requests.' }
$required=@('AgenticView.Server.dll','AgenticView.Server.runtimeconfig.json','AgenticView.Server.deps.json','wwwroot/index.html','desktop/AgenticView.Desktop.exe','desktop/AgenticView.Desktop.dll','desktop/AgenticView.Desktop.runtimeconfig.json','desktop/AgenticView.Desktop.deps.json')
$passed=[Collections.Generic.List[string]]::new()
foreach($mode in @('stage','sha-mismatch','traversal','absolute','duplicate','credential','database','log','symlink','apply-without-installation')){
    $root=Join-Path ([IO.Path]::GetTempPath()) ('agenticview-console-update-contract-'+[Guid]::NewGuid().ToString('N'))
    try {
        foreach($directory in @('scripts','.git','dist/server','dist/desktop')){[IO.Directory]::CreateDirectory((Join-Path $root $directory))|Out-Null}
        $script=Join-Path $root 'scripts/pull-console-update.ps1';Copy-Item -LiteralPath $SourceScript -Destination $script
        $server=Join-Path $root 'dist/server/original-marker.txt';$desktop=Join-Path $root 'dist/desktop/original-marker.txt'
        [IO.File]::WriteAllText($server,'retained original server output');[IO.File]::WriteAllText($desktop,'retained original desktop output')
        $serverHash=(Get-FileHash -LiteralPath $server).Hash;$desktopHash=(Get-FileHash -LiteralPath $desktop).Hash
        $bundle=Join-Path $root 'synthetic-runtime.zip'
        $file=[IO.File]::Open($bundle,[IO.FileMode]::CreateNew)
        $archive=[IO.Compression.ZipArchive]::new($file,[IO.Compression.ZipArchiveMode]::Create,$false)
        try {
            $names=@($required)
            switch($mode){
                'traversal' {$names+='../../escaped.txt'}
                'absolute' {$names+=(Join-Path $root 'absolute-owned.txt').Replace('\','/')}
                'duplicate' {$names+='WWWROOT/INDEX.HTML'}
                'credential' {$names+='credentials.json'}
                'database' {$names+='hub.sqlite-wal'}
                'log' {$names+='stdout.log.1'}
                'symlink' {$names+='linked-file'}
            }
            foreach($name in $names){
                $entry=$archive.CreateEntry($name)
                if($mode -eq 'symlink' -and $name -eq 'linked-file'){$entry.ExternalAttributes=-1577123840}
                $stream=$entry.Open()
                try {$bytes=[Text.Encoding]::UTF8.GetBytes($(if($name -eq 'credentials.json'){'SYNTHETIC_PRIVATE_VALUE_NEVER_DISPLAY'}else{'synthetic payload; never executable'}));$stream.Write($bytes,0,$bytes.Length)}finally{$stream.Dispose()}
            }
        }finally{$archive.Dispose();$file.Dispose()}
        $hash=(Get-FileHash -LiteralPath $bundle -Algorithm SHA256).Hash
        if($mode -eq 'sha-mismatch'){$hash='0'*64}
        $parameters=@{RuntimeZip=$bundle;Sha256=$hash};if($mode -eq 'apply-without-installation'){$parameters.Apply=$true}
        $global:LASTEXITCODE=0
        $output=(& $script @parameters|Out-String).Trim();$exitCode=$LASTEXITCODE
        $result=$output|ConvertFrom-Json
        if($mode -eq 'stage'){
            if($exitCode -ne 0 -or $result.phase -ne 'staged' -or $result.apply -or $result.newHub){throw 'Default update must stage only.'}
            foreach($name in $required){if(!(Test-Path -LiteralPath (Join-Path $result.stage ('payload/'+$name)) -PathType Leaf)){throw 'Staged runtime is incomplete.'}}
            if(Test-Path -LiteralPath (Join-Path $root '.task/runtime-updates/apply-state.json')){throw 'Plan must not write an Apply guard.'}
            if($result.relaunchCommand -notmatch 'pull-console-update\.ps1' -or $result.relaunchCommand -notmatch '\-Apply'){throw 'Staged receipt lacks its explicit operator command.'}
        }else{
            if($exitCode -ne 1 -or $result.phase -ne 'blocked' -or !$result.error){throw ('Unsafe update was not refused: '+$mode)}
        }
        if((Get-FileHash -LiteralPath $server).Hash -ne $serverHash -or (Get-FileHash -LiteralPath $desktop).Hash -ne $desktopHash -or @(Get-ChildItem -LiteralPath (Join-Path $root 'dist') -Recurse -File).Count -ne 2){throw 'Existing outputs changed during a staged or blocked update.'}
        if($output.Contains('SYNTHETIC_PRIVATE_VALUE_NEVER_DISPLAY')){throw 'Private payload content escaped into the receipt.'}
        if(Test-Path -LiteralPath (Join-Path $root 'escaped.txt')){throw 'Traversal escaped staging.'}
        if($global:consoleUpdateCalls -ne 0){throw 'Staging/refused Apply attempted a live operation.'}
        if($mode -eq 'apply-without-installation'){
            $guard=Get-Content -LiteralPath (Join-Path $root '.task/runtime-updates/apply-state.json') -Raw|ConvertFrom-Json
            if($guard.phase -ne 'blocked' -or $guard.newHub){throw 'Refused Apply must retain its blocked custody receipt.'}
        }
        $passed.Add($mode)
    }finally{
        $resolved=[IO.Path]::GetFullPath($root);$boundary=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\','/')+[IO.Path]::DirectorySeparatorChar
        if(!$resolved.StartsWith($boundary,[StringComparison]::OrdinalIgnoreCase) -or ![IO.Path]::GetFileName($resolved).StartsWith('agenticview-console-update-contract-')){throw 'Unsafe fixture cleanup target.'}
        if(Test-Path -LiteralPath $resolved){Remove-Item -LiteralPath $resolved -Recurse -Force}
    }
}
@{passed=$passed.Count;cases=@($passed);liveOperations=$global:consoleUpdateCalls;workingSetBytes=[Diagnostics.Process]::GetCurrentProcess().WorkingSet64;scope='Synthetic local ZIP staging and refused Apply only; no process, network, server, browser or authentication operation.'}|ConvertTo-Json -Compress
