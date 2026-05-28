param(
    [switch]$Force,
    [Parameter(Mandatory = $false)][string]$HostOnlySourceAddress = "192.0.2.1"
)

# Bootstrap fallback only. Enables Windows OpenSSH server so an operator can
# reach the guest from the host (over the isolated network) when the QGA
# control plane is unavailable. NOT intended as the steady-state control
# plane: the Crucible mTLS HTTP service is the primary surface.

$ErrorActionPreference = "Stop"

if (-not $Force) {
    Write-Output (@{
        enabled = $false
        reason = "OpenSSH bootstrap is opt-in; pass -Force to enable"
    } | ConvertTo-Json -Compress)
    exit 0
}

$cap = Get-WindowsCapability -Online -Name "OpenSSH.Server~~~~0.0.1.0" -ErrorAction Stop
if ($cap.State -ne "Installed") {
    Add-WindowsCapability -Online -Name "OpenSSH.Server~~~~0.0.1.0" | Out-Null
}

Set-Service -Name sshd -StartupType Automatic
Start-Service -Name sshd

# Constrain the auto-created OpenSSH inbound rule to the host-only control
# address so SSH cannot be reached from anywhere else, even though the
# isolated network already drops outside traffic.
$rule = Get-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -ErrorAction SilentlyContinue
if ($null -ne $rule) {
    Set-NetFirewallRule `
        -Name "OpenSSH-Server-In-TCP" `
        -Enabled True `
        -Profile Any `
        -RemoteAddress $HostOnlySourceAddress | Out-Null
}

$service = Get-Service -Name sshd
[ordered]@{
    enabled = $service.Status.ToString() -eq "Running"
    status = $service.Status.ToString()
    capabilityState = (Get-WindowsCapability -Online -Name "OpenSSH.Server~~~~0.0.1.0").State.ToString()
    remoteAddress = $HostOnlySourceAddress
    note = "Bootstrap fallback only. Disable once Crucible guest service is healthy."
} | ConvertTo-Json -Compress
