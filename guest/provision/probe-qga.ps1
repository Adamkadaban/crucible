$ErrorActionPreference = "Stop"

# Lightweight readiness probe for the QGA bootstrap flow. The provisioning
# pipeline runs this once qemu-ga is responsive to confirm PowerShell itself
# is reachable and that the runtime is recent enough. Account creation is
# intentionally validated by the later local-accounts-created stage, because
# realism can customize account names and the accounts do not exist yet here.
# The JSON payload is captured by the host so we can surface a useful detail
# string in CLI / health reports.

$psVersionDetected = $PSVersionTable.PSVersion.ToString()
$psEditionDetected = $PSVersionTable.PSEdition
$osVersion = [System.Environment]::OSVersion.VersionString
$hostName = [System.Environment]::MachineName
$qemuAgent = Get-Service -Name "qemu-ga" -ErrorAction SilentlyContinue
$qemuAgentStatus = if ($null -eq $qemuAgent) { "missing" } else { $qemuAgent.Status.ToString() }

$psMajor = $PSVersionTable.PSVersion.Major
$healthy = $psMajor -ge 5 -and $qemuAgentStatus -eq "Running"

$payload = [ordered]@{
    powershellVersion = $psVersionDetected
    powershellEdition = $psEditionDetected
    osVersion = $osVersion
    hostName = $hostName
    qemuAgentStatus = $qemuAgentStatus
    healthy = $healthy
}

$payload | ConvertTo-Json -Compress

if (-not $healthy) {
    exit 1
}
