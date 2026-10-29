param([Parameter(Mandatory)][string]$SourceScript)
$ErrorActionPreference='Stop'
$global:previewProbe=$null
function global:Start-Process {
    param($FilePath,$ArgumentList,$WorkingDirectory,$WindowStyle,$RedirectStandardOutput,$RedirectStandardError,[switch]$PassThru)
    $p=$global:previewProbe; $p.Starts++
    $receipt=Get-Content -LiteralPath (Join-Path $p.Root '.task/preview-session.json') -Raw|ConvertFrom-Json
    if($receipt.Phase -ne 'launch-intent' -or $receipt.ProcessId -ne 0){throw 'Launch intent was not retained before process creation.'}
    [IO.Directory]::CreateDirectory($receipt.Data)|Out-Null
    [IO.File]::WriteAllText((Join-Path $receipt.Data 'credentials.json'),'{"viewerToken":"synthetic-private-preview-key-at-least-32"}')
    $process=[pscustomobject]@{Id=424242;StartTime=[datetime]'2024-01-02T03:04:05.1234565Z';HasExited=$false}
    $process|Add-Member -MemberType ScriptMethod -Name Refresh -Value {}
    $p.Process=$process; $p.Entry=$receipt.Entry; $p.Executable=$FilePath
    return $process
}
function global:Get-CimInstance {
    param($ClassName,$Filter)
    $p=$global:previewProbe
    if(!$p.Process -or $p.Process.HasExited){return $null}
    [pscustomobject]@{ProcessId=$p.Process.Id;ExecutablePath=$p.Executable;CommandLine=if($p.Mode -eq 'mismatch'){'unrelated-command'}else{'"'+$p.Entry+'"'};CreationDate=[datetime]'2024-01-02T03:04:05.1234560Z'}
}
function global:Stop-Process {
    param($Id,$ErrorAction)
    $p=$global:previewProbe
    if($Id -ne 424242){throw 'Attempted to stop an unowned process.'}
    $p.Stops++;if($p.Mode -ne 'old-refuses-exit'){$p.Process.HasExited=$true}
}
function global:Wait-Process { param($Id,$Timeout,$ErrorAction) }
function global:Get-NetTCPConnection { param($LocalPort,$State,$ErrorAction);[pscustomobject]@{OwningProcess=if($global:previewProbe.Mode -eq 'wrong-listener'){999999}else{424242}} }
function global:Start-Sleep { param($Milliseconds,$Seconds) }
function global:Invoke-RestMethod {
    param($Uri,$TimeoutSec)
    $p=$global:previewProbe
    $receipt=Get-Content -LiteralPath (Join-Path $p.Root '.task/preview-session.json') -Raw|ConvertFrom-Json
    if($receipt.ProcessId -ne 424242 -or $receipt.Phase -ne 'starting' -or !$receipt.CreatedUtc){throw 'Native process receipt was not retained before health wait.'}
    if($p.Mode -notin @('success','wrong-listener')){throw 'Synthetic startup failure.'}
    return @{runtime='.NET 10'}
}
$passed=0
foreach($mode in @('success','failure','mismatch','uncertain','wrong-listener','old-refuses-exit')){
    $root=Join-Path ([IO.Path]::GetTempPath()) ('agenticview-preview-contract-'+[Guid]::NewGuid().ToString('N'))
    try {
        [IO.Directory]::CreateDirectory((Join-Path $root 'scripts'))|Out-Null
        [IO.Directory]::CreateDirectory((Join-Path $root 'dist/server/wwwroot'))|Out-Null
        Copy-Item -LiteralPath $SourceScript -Destination (Join-Path $root 'scripts/start-preview.ps1')
        [IO.File]::WriteAllText((Join-Path $root 'dist/server/AgenticView.Server.dll'),'synthetic app; never executed')
        [IO.File]::WriteAllText((Join-Path $root 'dist/server/wwwroot/index.html'),'<title>Synthetic fixture</title>')
        $global:previewProbe=[pscustomobject]@{Root=$root;Mode=$mode;Starts=0;Stops=0;Process=$null;Entry='';Executable=''}
        if($mode -eq 'uncertain'){
            [IO.Directory]::CreateDirectory((Join-Path $root '.task'))|Out-Null
            [IO.File]::WriteAllText((Join-Path $root '.task/preview-session.json'),'{"Phase":"launch-intent","ProcessId":0}')
        }
        $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0);$listener.Start();$port=$listener.LocalEndpoint.Port;$listener.Stop()
        if($mode -eq 'old-refuses-exit'){
            $prior=Join-Path $root '.task/preview/prior';$data=Join-Path $prior 'data';[IO.Directory]::CreateDirectory($data)|Out-Null
            [IO.File]::WriteAllText((Join-Path $data 'latest-marker.txt'),'retain latest data')
            $p=$global:previewProbe;$p.Entry=Join-Path $prior 'app/AgenticView.Server.dll';$p.Executable=(Get-Command dotnet).Source
            $p.Process=[pscustomobject]@{Id=424242;HasExited=$false}
            [IO.File]::WriteAllText((Join-Path $root '.task/preview-session.json'),(@{ProcessId=424242;Entry=$p.Entry;Data=$data;CreatedUtc='2024-01-02T03:04:05.1234565Z';BuildHash='older';Url=('http://127.0.0.1:'+$port);Phase='ready'}|ConvertTo-Json))
        }
        $failed=$false
        try { & (Join-Path $root 'scripts/start-preview.ps1') -Port $port -Replace|Out-Null } catch { $failed=$true }
        $p=$global:previewProbe;$receipt=Get-Content -LiteralPath (Join-Path $root '.task/preview-session.json') -Raw|ConvertFrom-Json
        switch($mode){
            'success' {
                if($failed -or $receipt.Phase -ne 'ready' -or $p.Starts -ne 1 -or $p.Stops -ne 0){throw 'Healthy startup custody failed.'}
                $shortcut=Get-Content -LiteralPath $receipt.Relaunch -Raw
                if(!$shortcut.Contains('start-preview.ps1') -or !$shortcut.Contains('-Replace')){throw 'Relaunch shortcut bypasses owned startup custody.'}
                $null=& (Join-Path $root 'scripts/start-preview.ps1') -Port $port -Replace
                if($p.Starts -ne 1 -or $p.Stops -ne 0){throw 'Same-build reuse launched or stopped another process.'}
            }
            'failure' {if(!$failed -or $receipt.Phase -ne 'failed' -or $p.Stops -ne 1 -or !(Test-Path -LiteralPath $receipt.Data)){throw 'Owned startup failure did not stop only the created process and retain latest data.'}}
            'mismatch' {if(!$failed -or $receipt.Phase -ne 'termination-uncertain' -or $p.Stops -ne 0){throw 'Mismatched process identity was not protected.'}}
            'uncertain' {if(!$failed -or $p.Starts -ne 0 -or $p.Stops -ne 0){throw 'Uncertain startup was automatically retried.'}}
            'wrong-listener' {if(!$failed -or $receipt.Phase -ne 'failed' -or $p.Stops -ne 1 -or (Test-Path -LiteralPath $receipt.ViewerKeyFile)){throw 'A foreign listener was accepted or received viewer bootstrap.'}}
            'old-refuses-exit' {if(!$failed -or $p.Starts -ne 0 -or $p.Stops -ne 1 -or !(Test-Path -LiteralPath (Join-Path $receipt.Data 'latest-marker.txt'))){throw 'Replacement copied or launched while the old hub still owned its data.'}}
        }
        $passed++
    } finally {
        $resolved=[IO.Path]::GetFullPath($root)
        $boundary=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)+[IO.Path]::DirectorySeparatorChar
        if(!$resolved.StartsWith($boundary,[StringComparison]::OrdinalIgnoreCase) -or ![IO.Path]::GetFileName($resolved).StartsWith('agenticview-preview-contract-')){throw 'Unsafe fixture cleanup target.'}
        if(Test-Path -LiteralPath $resolved){Remove-Item -LiteralPath $resolved -Recurse -Force}
    }
}
@{passed=$passed;scope='Synthetic process and health contracts only; no server/UI/auth process launched.'}|ConvertTo-Json -Compress
