#Requires -Version 7.2
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$GatewayRoot,
    [ValidateSet('Status','Connect','LoginWorker')][string]$Operation = 'Status'
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($GatewayRoot))
$workerState = Join-Path $root 'connection-worker.json'
$authPath = Join-Path $root 'auth/auth.json'
function Read-Private([string]$Path) { if (Test-Path -LiteralPath $Path -PathType Leaf) { Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json } }
function Same-Start([datetime]$Actual,[datetime]$Saved) {
    # CIM reports microseconds; Process.StartTime can retain a seventh fractional digit.
    return $Actual.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.ffffffZ') -ceq $Saved.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.ffffffZ')
}
function Auth-Present { $auth=Read-Private $authPath; return $null -ne $auth -and [bool]$auth.access_token }
function Worker-Process {
    $saved=Read-Private $workerState
    if (!$saved -or $saved.phase -ne 'running') { return $null }
    $process=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$saved.pid) -ErrorAction SilentlyContinue
    if ($process -and $process.ExecutablePath -eq $saved.executable -and $process.CommandLine.Contains('LoginWorker') -and $process.CommandLine.Contains($root) -and (Same-Start $process.CreationDate $saved.startedUtc) -and [DateTime]::UtcNow -lt ([datetime]$saved.deadlineUtc).ToUniversalTime()) { return $process }
    return $null
}
function Status {
    $present=Auth-Present; $worker=Worker-Process
    $result=[ordered]@{state=if($present){'authentication_saved'}elseif($worker){'login_pending'}else{'deferred'};authenticationPresent=$present;automaticInferenceRequests=0;message=if($present){'Separate gateway authentication is saved. Connect starts or reuses the configured gateway; no inference check is automatic.'}elseif($worker){'Finish the separate device login before the displayed expiry, then check connection status.'}else{'Subscription login is deferred. Connect starts a fresh separate gateway login only when you choose it.'}}
    if ($worker -and !$present) {
        $saved=Read-Private $workerState; $result.expiresAt=$saved.deadlineUtc
        $logPath=Join-Path $root 'login-private.log'
        if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).LastWriteTimeUtc -ge ([datetime]$saved.startedUtc).ToUniversalTime()) {
            # Never return raw authentication logs, access/refresh tokens, or stale device codes.
            $log=Get-Content -LiteralPath $logPath -Tail 30 | Out-String
            $codes=[regex]::Matches($log,'(?<![A-Za-z0-9])([A-Z0-9]{4,5}-[A-Z0-9]{4,5})(?![A-Za-z0-9])')
            if ($codes.Count -gt 0) { $result.verificationUrl='https://auth.openai.com/codex/device'; $result.deviceCode=$codes[$codes.Count-1].Groups[1].Value }
        }
    }
    return $result
}
function Start-ConfiguredGateway {
    $listener=@(Get-NetTCPConnection -LocalPort 4319 -State Listen -ErrorAction SilentlyContinue)
    if ($listener.Count -gt 0) {
        $saved=Read-Private (Join-Path $root 'process.json')
        if (!$saved) { throw 'Gateway port has an unidentified listener.' }
        $process=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$saved.pid) -ErrorAction SilentlyContinue
        if (!$process -or $process.ExecutablePath -ne $saved.executable -or !$process.CommandLine.Contains((Join-Path $root 'start-gateway.py')) -or !(Same-Start $process.CreationDate $saved.startedAt) -or @($listener | Where-Object OwningProcess -ne $process.ProcessId).Count -gt 0) { throw 'Gateway listener ownership differs from the private receipt.' }
        return
    }
    & (Join-Path $root 'Start-Gateway.ps1') *> (Join-Path $root 'connection-start-private.log')
}
try {
    if (!(Test-Path -LiteralPath $root -PathType Container)) { throw 'Gateway setup is unavailable.' }
    if ($Operation -eq 'Status') { Status | ConvertTo-Json -Depth 5 -Compress; exit 0 }
    foreach ($required in @('login-bounded.py','Start-Gateway.ps1','start-gateway.py','config.yaml','private.json','venv/Scripts/python.exe')) { if (!(Test-Path -LiteralPath (Join-Path $root $required) -PathType Leaf)) { throw 'Gateway setup is incomplete.' } }
    if ($Operation -eq 'LoginWorker') {
        $loginLog=Join-Path $root 'login-private.log'
        if (Test-Path -LiteralPath $loginLog -PathType Leaf) {
            $retained=[IO.Path]::GetFullPath((Join-Path $root ('login-private-retained-'+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmss')+'-'+[Guid]::NewGuid().ToString('N')+'.log')))
            if (!$retained.StartsWith($root.TrimEnd('\','/')+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Retained log escaped gateway root.' }
            Move-Item -LiteralPath $loginLog -Destination $retained
        }
        $login=Start-Process -FilePath (Join-Path $root 'venv/Scripts/python.exe') -ArgumentList @('-u',('"'+(Join-Path $root 'login-bounded.py')+'"')) -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $root 'connection-login.stdout.log') -RedirectStandardError (Join-Path $root 'connection-login.stderr.log') -PassThru
        try { if (!$login.WaitForExit(620000)) { $login.Kill($true); $login.WaitForExit(); throw 'The owned login deadline expired.' }; if ($login.ExitCode -eq 0 -and (Auth-Present)) { Start-ConfiguredGateway } }
        finally { $login.Dispose() }
        exit 0
    }
    $identity=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($root))).Substring(0,16)
    $mutex=[Threading.Mutex]::new($false,('Local\AgenticView.SubscriptionConnect.'+$identity))
    if (!$mutex.WaitOne(5000)) { throw 'Another connection request is being prepared.' }
    try {
        if (Auth-Present) { Start-ConfiguredGateway }
        elseif (!(Worker-Process)) {
            $previous=Read-Private $workerState
            if ($previous -and ($previous.phase -eq 'launch-intent' -or [DateTime]::UtcNow -lt ([datetime]$previous.deadlineUtc).ToUniversalTime())) { throw 'Prior login launch is uncertain. Inspect its private process receipt before retrying.' }
            $owned=@(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($root) -and ($_.CommandLine.Contains('login-bounded.py') -or $_.CommandLine.Contains('LoginWorker')) -and $_.ProcessId -ne $PID })
            if ($owned.Count -gt 0) { throw 'A previous login process still exists. Inspect it before retrying.' }
            # An explicit operator click is the only path that starts authentication.
            $executable=(Get-Process -Id $PID).Path
            $arguments=@('-NoProfile','-NonInteractive','-File',('"'+$PSCommandPath+'"'),'-GatewayRoot',('"'+$root+'"'),'-Operation','LoginWorker')
            $intent=[ordered]@{phase='launch-intent';requestedUtc=[DateTime]::UtcNow.ToString('O');deadlineUtc=[DateTime]::UtcNow.AddSeconds(620).ToString('O')}
            [IO.File]::WriteAllText($workerState,($intent|ConvertTo-Json),[Text.UTF8Encoding]::new($false))
            $child=Start-Process -FilePath $executable -ArgumentList $arguments -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $root 'connection-worker.stdout.log') -RedirectStandardError (Join-Path $root 'connection-worker.stderr.log') -PassThru
            try { $saved=[ordered]@{phase='running';pid=$child.Id;executable=$executable;startedUtc=$child.StartTime.ToUniversalTime().ToString('O');deadlineUtc=$intent.deadlineUtc}; [IO.File]::WriteAllText($workerState,($saved|ConvertTo-Json),[Text.UTF8Encoding]::new($false)) } finally { $child.Dispose() }
            Start-Sleep -Milliseconds 500
        }
        Status | ConvertTo-Json -Depth 5 -Compress
    } finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
} catch {
    # Connector results are operator-visible and must never echo private paths or token-bearing errors.
    @{state='unavailable';message='Inspect the private gateway setup and process receipts on its owning machine. No inference request was made.'} | ConvertTo-Json -Compress
    exit 1
}
