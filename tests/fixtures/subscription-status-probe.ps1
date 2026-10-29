param([string]$Script,[string]$Root)
$ErrorActionPreference='Stop'
$global:subscriptionFixtureRoot=$Root
function global:Get-CimInstance {
    # Synthetic native receipt: no process or authentication flow is started.
    [pscustomobject]@{ProcessId=42;ExecutablePath='synthetic-pwsh';CommandLine=('LoginWorker '+$global:subscriptionFixtureRoot);CreationDate=[datetime]'2024-01-02T03:04:05.1234560Z'}
}
& $Script -GatewayRoot $Root -Operation Status
