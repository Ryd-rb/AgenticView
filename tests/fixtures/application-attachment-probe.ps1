param([Parameter(Mandatory)][string]$SourceScript)
$ErrorActionPreference='Stop'
$global:attachmentProbe=$null
function Assert-Contract([bool]$Condition,[string]$Message){if(!$Condition){throw $Message}}
function global:Start-Sleep {param($Milliseconds)}
function global:Invoke-RestMethod {
    param($Uri,$Method,$Headers,$ContentType,$Body,$TimeoutSec,$MaximumRedirection)
    $p=$global:attachmentProbe;$path=([uri]$Uri).AbsolutePath
    $saved=Get-Content -LiteralPath $p.State -Raw|ConvertFrom-Json -AsHashtable
    $p.Calls.Add(@{Path=$path;Method=$Method;Body=$Body;Authorization=$Headers.Authorization})
    Assert-Contract (!$path.Contains('/parent-run/')) 'The parent application was changed.'
    Assert-Contract (!$path.Contains('/invoke')) 'Attachment invoked a configured action.'
    if($path -eq '/api/agents/register'){
        Assert-Contract ($saved.registration.requestId -eq ($Body|ConvertFrom-Json).requestId) 'Registration body was not durable before submission.'
        if($p.Mutate){[IO.File]::WriteAllText($p.Manifest,$p.Original.Replace('Synthetic utility','Changed utility'));$p.Mutate=$false}
        return @{runId='child-run';runToken='synthetic-child-token';sequence=$p.Sequence}
    }
    Assert-Contract ($Headers.Authorization -eq 'Bearer synthetic-child-token') 'A child request used another token.'
    if($path.EndsWith('/controls')){
        Assert-Contract ($saved.configuration.actions[0].target -eq 'synthetic-setup-connector') 'Configuration was not durable or bound.'
        return @{configurationVersion=1}
    }
    if($path.EndsWith('/publish')){
        Assert-Contract ($saved.batch.sequence -eq ($Body|ConvertFrom-Json).sequence) 'Publish batch was not durable before submission.'
        if($p.PublishFailures -gt 0){$p.PublishFailures--;throw 'Synthetic lost acknowledgement.'}
        return @{sequence=($Body|ConvertFrom-Json).sequence}
    }
    if($path.EndsWith('/application')){return @{saved=$true}}
    if($path.EndsWith('/heartbeat')){return @{archived=$false}}
    throw 'Unexpected attachment API request.'
}
$root=Join-Path ([IO.Path]::GetTempPath()) ('agenticview-attachment-contract-'+[guid]::NewGuid().ToString('N'))
try{
    $repository=Join-Path $root 'repository';$scripts=Join-Path $repository 'scripts'
    [IO.Directory]::CreateDirectory($scripts)|Out-Null
    $script=Join-Path $scripts 'attach-application.ps1';Copy-Item -LiteralPath $SourceScript -Destination $script
    $connection=Join-Path $root 'connection.json';$parent=Join-Path $root 'parent.json';$manifest=Join-Path $root 'manifest.json';$bindings=Join-Path $root 'bindings.json';$state=Join-Path $root 'private/state.json'
    [IO.File]::WriteAllText($connection,'{"url":"http://127.0.0.1:4317","ingestionKey":"synthetic-installation-key"}')
    [IO.File]::WriteAllText($parent,'{"runId":"parent-run","runToken":"synthetic-parent-token"}')
    $original='{"schemaVersion":1,"id":"utility","version":"1.0.0","name":"Synthetic utility","permanent":true,"bindings":[{"id":"setup","label":"Setup connector"}],"actions":[{"id":"status","label":"Status","kind":"custom","target":"setup","handler":"status","fields":[]}],"components":[{"id":"tasks","kind":"markdown","title":"Tasks","data":{"text":"Current task"}}]}'
    [IO.File]::WriteAllText($manifest,$original);[IO.File]::WriteAllText($bindings,'{"setup":"synthetic-setup-connector"}')
    $global:attachmentProbe=[pscustomobject]@{State=$state;Manifest=$manifest;Original=$original;Calls=[Collections.Generic.List[object]]::new();Mutate=$true;PublishFailures=1;Sequence=40}
    $arguments=@{ConnectionFile=$connection;ParentStateFile=$parent;Manifest=$manifest;BindingsFile=$bindings;StateFile=$state}
    $output=& $script @arguments|Out-String;$result=$output|ConvertFrom-Json
    $calls=$global:attachmentProbe.Calls
    Assert-Contract ($result.attached -and $result.actionsInvoked -eq 0 -and $result.runId -eq 'child-run') 'Attachment did not complete.'
    Assert-Contract (!$output.Contains('token') -and !$output.Contains('installation-key')) 'Attachment output exposed private input.'
    Assert-Contract ($calls.Count -eq 5) 'Attachment request count differs.'
    $registration=$calls[0].Body|ConvertFrom-Json
    Assert-Contract ($registration.parentId -eq 'parent-run' -and $registration.parentToken -eq 'synthetic-parent-token' -and $registration.name -eq 'Synthetic utility') 'Registration did not use the captured parent and manifest.'
    Assert-Contract ($calls[2].Body -ceq $calls[3].Body) 'A lost publish acknowledgement changed the batch.'
    $portable=$calls[4].Body|ConvertFrom-Json
    Assert-Contract ($portable.name -eq 'Synthetic utility' -and $portable.actions[0].target -eq 'setup') 'Logical portable bindings were changed or input was reread.'
    $passed=1

    $calls.Clear();$failed=$false
    try{& $script @arguments|Out-Null}catch{$failed=$true}
    Assert-Contract ($failed -and $calls.Count -eq 0) 'Changed input reused an earlier attachment identity.';$passed++

    [IO.File]::WriteAllText($manifest,$original);$output=& $script @arguments|Out-String
    Assert-Contract ($calls.Count -eq 1 -and $calls[0].Path -eq '/api/agents/child-run/heartbeat') 'Completed retry reconfigured the child or parent.';$passed++

    $calls.Clear();[IO.File]::WriteAllText($connection,'{"url":"http://127.0.0.1:5317","ingestionKey":"synthetic-installation-key"}');$failed=$false
    try{& $script @arguments|Out-Null}catch{$failed=$true}
    Assert-Contract ($failed -and $calls.Count -eq 0) 'Private attachment state was reused against another installation.';$passed++

    [IO.File]::WriteAllText($connection,'{"url":"http://127.0.0.1:4317","ingestionKey":"synthetic-installation-key"}')
    $state=Join-Path $root 'private/interrupted.json';$arguments.StateFile=$state;$global:attachmentProbe.State=$state;$global:attachmentProbe.PublishFailures=3;$global:attachmentProbe.Sequence=80
    $failed=$false;try{& $script @arguments|Out-Null}catch{$failed=$true}
    Assert-Contract $failed 'An unacknowledged publish was reported as success.'
    $before=Get-Content -LiteralPath $state -Raw|ConvertFrom-Json -AsHashtable
    $calls.Clear();$global:attachmentProbe.Sequence=90;$null=& $script @arguments
    $after=Get-Content -LiteralPath $state -Raw|ConvertFrom-Json -AsHashtable
    Assert-Contract ($before.requestId -eq $after.requestId -and $after.batch.sequence -eq 81 -and $after.phase -eq 'complete') 'Interrupted retry replaced registration or publish identity.'
    Assert-Contract (@($calls|Where-Object Path -like '*/controls').Count -eq 0 -and ($calls|Where-Object Path -like '*/publish').Body.Contains('81')) 'Interrupted retry reconfigured or allocated a different sequence.';$passed++

    [IO.File]::WriteAllText($manifest,('x'*262145));$calls.Clear();$failed=$false
    try{& $script @arguments|Out-Null}catch{$failed=$true}
    Assert-Contract ($failed -and $calls.Count -eq 0) 'Oversized input reached the hub.';$passed++
    @{passed=$passed;scope='Synthetic API contracts only; no action, network, login or process was executed.'}|ConvertTo-Json -Compress
}finally{
    $resolved=[IO.Path]::GetFullPath($root);$boundary=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)+[IO.Path]::DirectorySeparatorChar
    if(!$resolved.StartsWith($boundary,[StringComparison]::OrdinalIgnoreCase) -or ![IO.Path]::GetFileName($resolved).StartsWith('agenticview-attachment-contract-')){throw 'Unsafe fixture cleanup target.'}
    if(Test-Path -LiteralPath $resolved){Remove-Item -LiteralPath $resolved -Recurse -Force}
}
