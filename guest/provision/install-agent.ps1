[CmdletBinding()]
param(
    [Parameter()]
    [string]$ServiceName = "CrucibleGuestAgent",

    [Parameter()]
    [string]$AgentPath = "C:\Program Files\Crucible\crucible-agent.exe",

    [Parameter()]
    [string]$CertDirectory = "C:\ProgramData\Crucible\Agent\certs",

    [Parameter(Mandatory = $true)]
    [string]$ControlAddress,

    [Parameter(Mandatory = $true)]
    [string]$HostOnlySourceAddress,

    [Parameter(Mandatory = $true)]
    [int]$ControlPort
)

$ErrorActionPreference = "Stop"

if ($HostOnlySourceAddress -eq "0.0.0.0" -or $HostOnlySourceAddress -eq "::") {
    throw "HostOnlySourceAddress must be a narrow host-only address"
}

if ($ControlPort -lt 1 -or $ControlPort -gt 65535) {
    throw "ControlPort must be between 1 and 65535"
}

$caCertificate = Join-Path $CertDirectory "ca.cert.pem"
$serverCertificate = Join-Path $CertDirectory "guest-server.cert.pem"
$serverPrivateKey = Join-Path $CertDirectory "guest-server.key.pem"

foreach ($path in @($caCertificate, $serverCertificate, $serverPrivateKey)) {
    if (-not (Test-Path -LiteralPath $path)) {
        throw "Missing staged mTLS material: $path"
    }
}

if (-not (Test-Path -LiteralPath $AgentPath)) {
    throw "Missing guest agent executable: $AgentPath"
}

$binaryPath = @(
    '"{0}"' -f $AgentPath,
    "run",
    "--listen-address", $ControlAddress,
    "--listen-port", $ControlPort,
    "--ca-cert", ('"{0}"' -f $caCertificate),
    "--server-cert", ('"{0}"' -f $serverCertificate),
    "--server-key", ('"{0}"' -f $serverPrivateKey)
) -join " "

$existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($null -eq $existingService) {
    New-Service -Name $ServiceName -DisplayName "Crucible Guest Agent" -BinaryPathName $binaryPath -StartupType Automatic | Out-Null
}
else {
    if ($existingService.Status -ne "Stopped") {
        Stop-Service -Name $ServiceName -Force
    }
    sc.exe config $ServiceName binPath= $binaryPath start= auto | Out-Null
}

$ruleName = "Crucible Guest Agent Host-Only Control"
$existingRule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if ($null -ne $existingRule) {
    Remove-NetFirewallRule -DisplayName $ruleName
}

New-NetFirewallRule `
    -DisplayName $ruleName `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalAddress $ControlAddress `
    -LocalPort $ControlPort `
    -RemoteAddress $HostOnlySourceAddress `
    -Profile Any | Out-Null

Start-Service -Name $ServiceName

[PSCustomObject]@{
    serviceName = $ServiceName
    controlAddress = $ControlAddress
    controlPort = $ControlPort
    remoteAddress = $HostOnlySourceAddress
    firewallRule = $ruleName
    opensshBootstrapOnly = $true
} | ConvertTo-Json -Compress
