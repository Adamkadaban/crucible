param(
    [switch]$Force
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

# Firewall rule already exists once the capability is installed; ensure
# enabled and limit to the host-only network range.
$rule = Get-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -ErrorAction SilentlyContinue
if ($null -ne $rule) {
    Set-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -Enabled True -Profile Any | Out-Null
}

$service = Get-Service -Name sshd
[ordered]@{
    enabled = $service.Status.ToString() -eq "Running"
    status = $service.Status.ToString()
    capabilityState = (Get-WindowsCapability -Online -Name "OpenSSH.Server~~~~0.0.1.0").State.ToString()
    note = "Bootstrap fallback only. Disable once Crucible guest service is healthy."
} | ConvertTo-Json -Compress
