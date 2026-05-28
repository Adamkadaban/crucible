$ErrorActionPreference = "Stop"

# Lightweight readiness probe for the QGA bootstrap flow. The provisioning
# pipeline runs this once qemu-ga is responsive to confirm PowerShell itself
# is reachable, that the runtime is recent enough, and that the analysis
# account context is present. The JSON payload is captured by the host so
# we can surface a useful detail string in CLI / health reports.

function Test-AccountExists {
    param([Parameter(Mandatory = $true)][string]$Name)
    try {
        $null = Get-LocalUser -Name $Name -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

$psVersion = $PSVersionTable.PSVersion.ToString()
$psEdition = $PSVersionTable.PSEdition
$osVersion = [System.Environment]::OSVersion.VersionString
$hostName = [System.Environment]::MachineName
$adminPresent = Test-AccountExists -Name "CrucibleAdmin"
$standardPresent = Test-AccountExists -Name "CrucibleUser"
$qemuAgent = Get-Service -Name "qemu-ga" -ErrorAction SilentlyContinue
$qemuAgentStatus = if ($null -eq $qemuAgent) { "missing" } else { $qemuAgent.Status.ToString() }

$psMajor = $PSVersionTable.PSVersion.Major
$healthy = $psMajor -ge 5 -and $adminPresent -and $standardPresent -and $qemuAgentStatus -eq "Running"

$payload = [ordered]@{
    powershellVersion = $psVersion
    powershellEdition = $psEdition
    osVersion = $osVersion
    hostName = $hostName
    crucibleAdminPresent = $adminPresent
    crucibleUserPresent = $standardPresent
    qemuAgentStatus = $qemuAgentStatus
    healthy = $healthy
}

$payload | ConvertTo-Json -Compress

if (-not $healthy) {
    exit 1
}
