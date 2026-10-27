param([string]$Endpoint = 'http://127.0.0.1:4317')
$ErrorActionPreference = 'Stop'
if (!$env:AV_INGEST_KEY) { throw 'Set AV_INGEST_KEY.' }
function Send-Observation($Path, $Key, $Payload) {
    Invoke-RestMethod -Uri ($Endpoint.TrimEnd('/') + $Path) -Method Post -Headers @{Authorization=('Bearer ' + $Key)} -ContentType 'application/json' -Body ($Payload | ConvertTo-Json -Depth 30)
}
$random = [Security.Cryptography.RandomNumberGenerator]::Create()
$bytes = New-Object byte[] 32
$random.GetBytes($bytes)
$random.Dispose()
$run = Send-Observation '/api/agents/register' $env:AV_INGEST_KEY @{requestId=[Guid]::NewGuid().ToString();registrationKey=[Convert]::ToBase64String($bytes);agentId='example-powershell';name='Synthetic PowerShell tool';role='Example'}
$path = '/api/agents/' + $run.runId
try {
    Send-Observation ($path + '/publish') $run.runToken @{sequence=1;operations=@(
        @{op='upsert';component=@{id='files';title='Synthetic files';kind='tree';data=@{nodes=@(@{id='root';label='Evidence'},@{id='log';label='generated.log';parentId='root';detail='synthetic'})}}},
        @{op='upsert';component=@{id='log';title='Activity';kind='logs';data=@{entries=@(@{level='info';message='Synthetic evidence listed'})}}}
    )} | Out-Null
    Read-Host 'Synthetic view published. Press Enter to archive'
} finally {
    Send-Observation ($path + '/archive') $run.runToken @{} | Out-Null
}
