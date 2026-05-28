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

function Assert-SingleHostAddress {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Address
    )

    $parsedAddress = [System.Net.IPAddress]::None
    if (-not [System.Net.IPAddress]::TryParse($Address, [ref]$parsedAddress)) {
        throw "HostOnlySourceAddress must be a single IP address"
    }

    if ($parsedAddress.Equals([System.Net.IPAddress]::Any) -or $parsedAddress.Equals([System.Net.IPAddress]::IPv6Any)) {
        throw "HostOnlySourceAddress must not be a wildcard address"
    }
}

Assert-SingleHostAddress -Address $HostOnlySourceAddress

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

$listenAddress = "${ControlAddress}:${ControlPort}"
# Build the binPath as an array first then join — wrap every format
# expression in parens because `-f` binds lower than the array comma
# operator, so `'"{0}"' -f $foo, "bar"` is parsed as
# `'"{0}"' -f ($foo, "bar")` (only $foo lands in the output, the rest of
# the array is eaten as a no-op format argument). Wrapping each entry in
# parens forces -f to bind to just that single value.
$binaryPath = @(
    ('"{0}"' -f $AgentPath),
    "run",
    "--listen", $listenAddress,
    "--tls-cert", ('"{0}"' -f $serverCertificate),
    "--tls-key", ('"{0}"' -f $serverPrivateKey),
    "--tls-client-ca", ('"{0}"' -f $caCertificate),
    "--staging-dir", '"C:\ProgramData\Crucible\staging"',
    "--audit-log", '"C:\ProgramData\Crucible\Agent\audit.jsonl"'
) -join " "

$scExe = "${env:SystemRoot}\System32\sc.exe"
$existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existingService -ne $null -and $existingService.Status -ne "Stopped") {
    Stop-Service -Name $ServiceName -Force
}
if ($null -ne $existingService) {
    & $scExe delete $ServiceName | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "sc.exe delete failed (exit $LASTEXITCODE)"
    }
    # SCM takes a moment to release the name after a delete.
    Start-Sleep -Seconds 1
}

# PowerShell mangles the `key=` `value` argv pattern sc.exe requires when
# the value contains spaces and embedded quotes (every workaround we tried
# — `& sc.exe @args`, `cmd /c sc.exe ...`, etc. — drops the binPath value
# on the way). The reliable fix is to write a literal .cmd file whose
# inner quotes are escaped as \" (which cmd's parser unescapes) and run
# that via cmd.exe — cmd.exe parses the command line directly without
# PowerShell's argv re-encoding.
$cmdBinPath = $binaryPath -replace '"', '\"'
$cmdPath = Join-Path $env:TEMP "crucible-install-agent-$([guid]::NewGuid().ToString('n')).cmd"
$cmdContent = @"
@echo off
"$scExe" create $ServiceName binPath= "$cmdBinPath" start= auto DisplayName= "Crucible Guest Agent"
exit /b %ERRORLEVEL%
"@
$cmdContent | Out-File -FilePath $cmdPath -Encoding ASCII
try {
    # Use Start-Process synchronously so we get a deterministic exit code
    # back regardless of PowerShell's native-command pipeline quirks.
    $proc = Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" `
        -ArgumentList "/c","`"$cmdPath`"" `
        -Wait -PassThru -NoNewWindow -RedirectStandardOutput "$cmdPath.out" `
        -RedirectStandardError "$cmdPath.err"
    $createExit = $proc.ExitCode
    $createOutput = (Get-Content "$cmdPath.out" -Raw -ErrorAction SilentlyContinue) +
                    (Get-Content "$cmdPath.err" -Raw -ErrorAction SilentlyContinue)
    Remove-Item "$cmdPath.out","$cmdPath.err" -ErrorAction SilentlyContinue
    if ($createExit -ne 0) {
        throw "sc.exe create failed (exit $createExit): $createOutput"
    }
} finally {
    Remove-Item -LiteralPath $cmdPath -ErrorAction SilentlyContinue
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

Start-Sleep -Seconds 1
# Use Start-Process so we get a real exit code; & sc.exe start from a
# -File script intermittently returns no $LASTEXITCODE.
$startProc = Start-Process -FilePath "$env:SystemRoot\System32\sc.exe" `
    -ArgumentList "start",$ServiceName `
    -Wait -PassThru -NoNewWindow
$startExit = $startProc.ExitCode
if ($startExit -ne 0) {
    throw "sc.exe start failed (exit $startExit)"
}

[PSCustomObject]@{
    serviceName = $ServiceName
    controlAddress = $ControlAddress
    controlPort = $ControlPort
    remoteAddress = $HostOnlySourceAddress
    firewallRule = $ruleName
    opensshBootstrapOnly = $true
} | ConvertTo-Json -Compress
