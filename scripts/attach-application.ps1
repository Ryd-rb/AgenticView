#Requires -Version 7.2
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ConnectionFile,
    [Parameter(Mandatory)][string]$ParentStateFile,
    [Parameter(Mandatory)][string]$Manifest,
    [Parameter(Mandatory)][string]$BindingsFile,
    [Parameter(Mandatory)][string]$StateFile
)
$ErrorActionPreference='Stop'
function Plain-Local([string]$Path) {
    $full=[IO.Path]::GetFullPath($Path)
    if($full.StartsWith('\\')){throw 'Use plain local files for application attachment.'}
    $walk=$full
    while($walk){if((Test-Path -LiteralPath $walk) -and ((Get-Item -LiteralPath $walk -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Application attachment files cannot use links.'};$walk=[IO.Path]::GetDirectoryName($walk)}
    return $full
}
foreach($path in @($ConnectionFile,$ParentStateFile,$Manifest,$BindingsFile,$StateFile)){$null=Plain-Local $path}
$StateFile=Plain-Local $StateFile
$sourceRoot=[IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
if($StateFile.StartsWith($sourceRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){
    & git -C $sourceRoot check-ignore --quiet -- $StateFile
    if($LASTEXITCODE -ne 0){throw 'Keep private application state outside tracked source or inside an ignored private directory.'}
}
function Read-Snapshot([string]$Path,[int]$Limit=262144){
    $stream=[IO.File]::Open((Plain-Local $Path),[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    try{
        if($stream.Length -gt $Limit){throw 'Application attachment input exceeds its bound.'}
        $bytes=[byte[]]::new([int]$stream.Length);$offset=0
        while($offset -lt $bytes.Length){$read=$stream.Read($bytes,$offset,$bytes.Length-$offset);if(!$read){throw 'Application attachment input was truncated.'};$offset+=$read}
        $raw=[Text.UTF8Encoding]::new($false,$true).GetString($bytes).TrimStart([char]0xfeff)
        try{$value=$raw|ConvertFrom-Json -AsHashtable}catch{throw 'Application attachment input is not valid JSON.'}
        return @{Raw=$raw;Value=$value}
    }finally{$stream.Dispose()}
}
function Read-Json([string]$Path,[int]$Limit=262144){return (Read-Snapshot $Path $Limit).Value}
function Digest([string]$Text){return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Text))).ToLowerInvariant()}
$connection=(Read-Snapshot $ConnectionFile 16384).Value;$parent=(Read-Snapshot $ParentStateFile 16384).Value
$manifestSnapshot=Read-Snapshot $Manifest;$bindingSnapshot=Read-Snapshot $BindingsFile 16384
$definition=$manifestSnapshot.Value;$bindings=$bindingSnapshot.Value
$description=[string]$definition.description
$origin=$null
if(![Uri]::TryCreate([string]$connection.url,[UriKind]::Absolute,[ref]$origin) -or ($origin.Scheme -ne 'https' -and !($origin.Scheme -eq 'http' -and $origin.IsLoopback)) -or $origin.UserInfo -or $origin.Query -or $origin.Fragment -or $origin.AbsolutePath -ne '/'){throw 'Use HTTPS or loopback HTTP for the configured hub.'}
if(!$parent.runId -or !$parent.runToken -or !$connection.ingestionKey -or $definition.schemaVersion -ne 1 -or !$definition.permanent){throw 'Private connection/parent state or portable definition is incomplete.'}
$declared=@($definition.bindings|ForEach-Object id)
if($bindings.Count -ne $declared.Count -or @($declared|Where-Object {!$bindings.ContainsKey($_)}).Count -gt 0){throw 'Supply exactly the definition logical bindings.'}
$identity=Digest ($origin.GetLeftPart([UriPartial]::Authority)+"`n"+$manifestSnapshot.Raw+"`n"+$bindingSnapshot.Raw+"`n"+$parent.runId+"`n"+(Digest $parent.runToken))
[IO.Directory]::CreateDirectory((Split-Path -Parent $StateFile))|Out-Null
$lock=[IO.File]::Open(($StateFile+'.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try {
    if(Test-Path -LiteralPath $StateFile){$state=Read-Json $StateFile 4194304;if($state.identity -cne $identity){throw 'Attachment inputs changed. Preserve this state and explicitly review the existing child configuration.'}}
    else{$state=@{identity=$identity;requestId=('application-child-'+[Guid]::NewGuid());registrationKey=[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32));parentId=$parent.runId;phase='prepared'}}
    function Save-State {
        $temporary=$StateFile+'.writing-'+[Guid]::NewGuid().ToString('N')
        [IO.File]::WriteAllText($temporary,($state|ConvertTo-Json -Depth 32),[Text.UTF8Encoding]::new($false));[IO.File]::Move($temporary,$StateFile,$true)
    }
    function Call-Api([string]$Path,[string]$Token,[object]$Body,[string]$Method='POST') {
        for($attempt=0;$attempt -lt 3;$attempt++){
            try{return Invoke-RestMethod -Uri ($origin.GetLeftPart([UriPartial]::Authority)+$Path) -Method $Method -Headers @{Authorization=('Bearer '+$Token)} -ContentType 'application/json' -Body ($Body|ConvertTo-Json -Depth 32 -Compress) -TimeoutSec 10 -MaximumRedirection 0}
            catch{if($attempt -eq 2){throw 'Application attachment was not acknowledged. Retain its private state for exact retry; no configured action was invoked.'};Start-Sleep -Milliseconds 200}
        }
    }
    Save-State
    if($state.phase -eq 'complete'){$observed=Call-Api ('/api/agents/'+$state.runId+'/heartbeat') $state.runToken @{};@{runId=$state.runId;parentId=$state.parentId;attached=(!$observed.archived);actionsInvoked=0}|ConvertTo-Json -Compress;return}
    if(!$state.registration){
        $state.registration=@{requestId=$state.requestId;registrationKey=$state.registrationKey;agentId=('application-child-'+(Digest $state.requestId).Substring(0,40));name=$definition.name;role='Application';context=$description;parentId=$parent.runId;parentToken=$parent.runToken}
        $actions=ConvertTo-Json -InputObject @($definition.actions|Where-Object {$null -ne $_}) -Depth 32|ConvertFrom-Json -AsHashtable -NoEnumerate
        foreach($action in $actions){if($action.target -ne 'agent'){$action.target=$bindings[$action.target]};if($action.connection){$action.connection.machineId=$bindings[$action.connection.machineId]}}
        $state.configuration=@{actions=@($actions);application=@{name=$definition.name;description=$description}}
        Save-State
    }
    $registered=Call-Api '/api/agents/register' $connection.ingestionKey $state.registration
    $state.runId=$registered.runId;$state.runToken=$registered.runToken;Save-State
    if(!$state.configured){$null=Call-Api ('/api/agents/'+$state.runId+'/controls') $state.runToken $state.configuration 'PUT';$state.configured=$true;Save-State}
    if(!$state.published){
        if(!$state.batch){$operations=@($definition.components|ForEach-Object {@{op='upsert';component=$_}});if(!$operations.Count){$operations=@(@{op='context';text=$description})};$state.batch=@{sequence=([long]$registered.sequence+1);operations=$operations};Save-State}
        $ack=Call-Api ('/api/agents/'+$state.runId+'/publish') $state.runToken $state.batch
        if([long]$ack.sequence -ne [long]$state.batch.sequence){throw 'Attachment sequence acknowledgement differs. Inspect retained state before continuing.'}
        $state.published=$true;Save-State
    }
    if(!$state.defined){$null=Call-Api ('/api/agents/'+$state.runId+'/application') $state.runToken $definition 'PUT';$state.defined=$true;Save-State}
    $state.phase='complete';Save-State
    @{runId=$state.runId;parentId=$state.parentId;attached=$true;actionsInvoked=0}|ConvertTo-Json -Compress
} finally {$lock.Dispose()}
