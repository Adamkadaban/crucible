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

# Locate the crucible-payload.iso CD-ROM by volume label. Per #130 we
# ship the agent binary and mTLS material on a read-only CD mounted at
# VM start instead of pushing them over qemu-ga writeFile — qemu-ga's
# guest-file-open races Windows filesystem minifilters with
# ERROR_SHARING_VIOLATION even on a fully Defender-disabled guest.
$payload = Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=5' |
    Where-Object { $_.VolumeName -eq 'CRUCIBLE' } |
    Select-Object -First 1
if (-not $payload) {
    throw "CRUCIBLE payload CD not found (Win32_LogicalDisk DriveType=5 VolumeName=CRUCIBLE)"
}
$payloadRoot = "$($payload.DeviceID)\"
$payloadAgent = Join-Path $payloadRoot "agent\crucible-agent.exe"
$payloadCa = Join-Path $payloadRoot "mtls\ca.cert.pem"
$payloadServerCert = Join-Path $payloadRoot "mtls\guest-server.cert.pem"
$payloadServerKey = Join-Path $payloadRoot "mtls\guest-server.key.pem"
foreach ($source in @($payloadAgent, $payloadCa, $payloadServerCert, $payloadServerKey)) {
    if (-not (Test-Path -LiteralPath $source)) {
        throw "Missing payload-CD file: $source"
    }
}

# Stage the agent binary + mTLS material from the payload CD onto the
# guest's writable filesystem. Copy-Item uses Win32 CopyFileExW which
# opens with FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
# cooperating with any other minifilter that briefly touches the new
# file — no sharing-violation race.
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $AgentPath) | Out-Null
New-Item -ItemType Directory -Force -Path $CertDirectory | Out-Null

# Stop a previous-run agent service / process FIRST so it releases its
# handle to $AgentPath before Copy-Item tries to overwrite. Without
# this, re-provisioning fails with "The process cannot access the file
# because it is being used by another process." even though the
# service status is Stopped — the EXE handle can linger briefly after
# process exit. Belt-and-braces: stop the service, sc-delete it, then
# kill any straggler process loaded from $AgentPath.
$priorService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($null -ne $priorService) {
    if ($priorService.Status -ne "Stopped") {
        Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
    }
    & "$env:SystemRoot\System32\sc.exe" delete $ServiceName 2>&1 | Out-Null
    Start-Sleep -Seconds 1
}
Get-Process -ErrorAction SilentlyContinue |
    Where-Object {
        ($_.Path -eq $AgentPath) -or
        ($_.ProcessName -eq "crucible-agent") -or
        ($_.ProcessName -eq "crucible-guest-agent")
    } |
    ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
# Kill anything still bound to the control port (TIME_WAIT or a
# rogue listener) before we try to start a fresh instance.
try {
    Get-NetTCPConnection -LocalPort $ControlPort -State Listen -ErrorAction SilentlyContinue |
        ForEach-Object {
            Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
        }
} catch {
    # Cmdlet missing on some SKUs — ignore.
}
# Wait up to 5s for any remaining file handles to release.
for ($i = 0; $i -lt 10; $i++) {
    if (-not (Test-Path -LiteralPath $AgentPath)) { break }
    try {
        # Probe write-access by opening with FILE_SHARE_NONE — succeeds
        # only if nothing else has the file open.
        $fs = [System.IO.File]::Open($AgentPath, 'Open', 'Write', 'None')
        $fs.Dispose()
        break
    } catch {
        Start-Sleep -Milliseconds 500
    }
}
# Wait up to 30s for the control port to release. Windows holds sockets
# in TIME_WAIT for 30-120s by default; we abandon waiting earlier and
# let the start-attempt fail loudly if the port is still held by
# someone unrelated (operator action item).
for ($i = 0; $i -lt 60; $i++) {
    $portInUse = $false
    try {
        $portInUse = $null -ne (Get-NetTCPConnection -LocalPort $ControlPort -State Listen -ErrorAction SilentlyContinue)
    } catch {
        # If Get-NetTCPConnection isn't available, fall back to a
        # try-bind probe.
        try {
            $tester = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse($ControlAddress), $ControlPort)
            $tester.Start()
            $tester.Stop()
            $portInUse = $false
        } catch {
            $portInUse = $true
        }
    }
    if (-not $portInUse) { break }
    Start-Sleep -Milliseconds 500
}

Copy-Item -LiteralPath $payloadAgent -Destination $AgentPath -Force
$caCertificate = Join-Path $CertDirectory "ca.cert.pem"
$serverCertificate = Join-Path $CertDirectory "guest-server.cert.pem"
$serverPrivateKey = Join-Path $CertDirectory "guest-server.key.pem"
# Pre-clear any read-only ACL the previous provision left on the
# private key so Copy-Item can overwrite it. icacls /reset re-applies
# inherited ACEs from the parent dir which grants SYSTEM full control.
# Safe to run when the file doesn't exist yet — icacls returns
# non-zero, which we swallow.
foreach ($target in @($caCertificate, $serverCertificate, $serverPrivateKey)) {
    if (Test-Path -LiteralPath $target) {
        & "$env:SystemRoot\System32\icacls.exe" $target /reset 2>&1 | Out-Null
    }
}
Copy-Item -LiteralPath $payloadCa -Destination $caCertificate -Force
Copy-Item -LiteralPath $payloadServerCert -Destination $serverCertificate -Force
Copy-Item -LiteralPath $payloadServerKey -Destination $serverPrivateKey -Force

# Lock down the mTLS private key: SYSTEM + Administrators read only.
& "$env:SystemRoot\System32\icacls.exe" $serverPrivateKey /inheritance:r /grant:r `
    "NT AUTHORITY\SYSTEM:(R)" "BUILTIN\Administrators:(R)" | Out-Null

foreach ($path in @($caCertificate, $serverCertificate, $serverPrivateKey)) {
    if (-not (Test-Path -LiteralPath $path)) {
        throw "Missing staged mTLS material: $path"
    }
}

if (-not (Test-Path -LiteralPath $AgentPath)) {
    throw "Missing guest agent executable: $AgentPath"
}

# Smoke-test the binary directly before we hand it to SCM. We start it
# with `run` on a sentinel port (so it doesn't collide with $ControlPort
# in case a previous attempt is still bound), capture stderr for ~3 s,
# then kill it. Surfaces any startup-time failure (missing CRT, bad PE,
# antimalware quarantine, TLS cert/key parse error, audit log path issue)
# with a clear stderr instead of an opaque "service stopped" later.
$smokePort = 18443
$smokeOut = Join-Path $env:TEMP "crucible-agent-smoke.out"
$smokeErr = Join-Path $env:TEMP "crucible-agent-smoke.err"
Remove-Item $smokeOut, $smokeErr -ErrorAction SilentlyContinue
$smokeArgs = @(
    "run",
    "--listen", "127.0.0.1:$smokePort",
    "--tls-cert", $serverCertificate,
    "--tls-key", $serverPrivateKey,
    "--tls-client-ca", $caCertificate,
    "--staging-dir", "C:\ProgramData\Crucible\staging",
    "--audit-log", "C:\ProgramData\Crucible\Agent\audit.jsonl"
)
$smoke = Start-Process -FilePath $AgentPath -ArgumentList $smokeArgs `
    -PassThru -NoNewWindow `
    -RedirectStandardOutput $smokeOut `
    -RedirectStandardError $smokeErr
Start-Sleep -Seconds 3
$smokeAlive = -not $smoke.HasExited
if ($smokeAlive) {
    Stop-Process -Id $smoke.Id -Force -ErrorAction SilentlyContinue
    $smoke.WaitForExit(2000) | Out-Null
}
$smokeStdout = (Get-Content -LiteralPath $smokeOut -Raw -ErrorAction SilentlyContinue) -as [string]
$smokeStderr = (Get-Content -LiteralPath $smokeErr -Raw -ErrorAction SilentlyContinue) -as [string]
Remove-Item $smokeOut, $smokeErr -ErrorAction SilentlyContinue
if (-not $smokeAlive -and $smoke.ExitCode -ne 0) {
    throw "Agent smoke-test (run --listen 127.0.0.1:$smokePort) failed: exit=$($smoke.ExitCode)`nstderr:`n$smokeStderr`nstdout:`n$smokeStdout"
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
# Service stop + delete already happened at the top of this script
# (before Copy-Item) so the old binary handle was released in time
# for the copy. Re-check here is a no-op now, kept as a guard against
# manual reruns that skip the pre-copy phase.
$existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($null -ne $existingService) {
    if ($existingService.Status -ne "Stopped") {
        Stop-Service -Name $ServiceName -Force
    }
    & $scExe delete $ServiceName | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "sc.exe delete failed (exit $LASTEXITCODE)"
    }
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

# `sc start` returns 0 the moment the SCM dispatches StartServiceCtrlDispatcher;
# the service can still crash a fraction of a second later (bad mTLS key
# permissions, port already in use, missing dep, etc.). Poll for up to 10 s
# to confirm it reaches Running, and if it doesn't, dump the audit log so
# the provisioning operator can see what went wrong.
$auditLog = "C:\ProgramData\Crucible\Agent\audit.jsonl"
$confirmedRunning = $false
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 500
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($null -ne $svc -and $svc.Status -eq "Running") {
        $confirmedRunning = $true
        break
    }
}
if (-not $confirmedRunning) {
    $finalSvc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    $finalStatus = if ($null -eq $finalSvc) { "missing" } else { $finalSvc.Status.ToString() }
    $auditTail = if (Test-Path -LiteralPath $auditLog) {
        Get-Content -LiteralPath $auditLog -Tail 50 -ErrorAction SilentlyContinue | Out-String
    } else {
        "(no audit log at $auditLog)"
    }
    $eventTail = try {
        Get-WinEvent -FilterHashtable @{LogName='System';ProviderName='Service Control Manager'} -MaxEvents 50 -ErrorAction Stop |
            Where-Object { $_.Message -match $ServiceName } |
            Select-Object -First 5 TimeCreated, Message |
            Format-List | Out-String
    } catch {
        "(unable to read System event log)"
    }
    # Run the agent directly with the same args the service config uses
    # for ~2 s so we can capture whatever stderr it prints before it
    # would normally have to talk to SCM. This sidesteps the SCM
    # process-state black box and surfaces the real crash cause
    # (port-bind error, cert read error, key parse error, ...).
    $directOut = Join-Path $env:TEMP "crucible-agent-direct.out"
    $directErr = Join-Path $env:TEMP "crucible-agent-direct.err"
    Remove-Item $directOut, $directErr -ErrorAction SilentlyContinue
    $directArgs = @(
        "run",
        "--listen", $listenAddress,
        "--tls-cert", $serverCertificate,
        "--tls-key", $serverPrivateKey,
        "--tls-client-ca", $caCertificate,
        "--staging-dir", "C:\ProgramData\Crucible\staging",
        "--audit-log", "C:\ProgramData\Crucible\Agent\audit.jsonl"
    )
    try {
        $direct = Start-Process -FilePath $AgentPath -ArgumentList $directArgs `
            -PassThru -NoNewWindow `
            -RedirectStandardOutput $directOut `
            -RedirectStandardError $directErr
        Start-Sleep -Seconds 2
        if (-not $direct.HasExited) {
            Stop-Process -Id $direct.Id -Force
            $direct.WaitForExit(2000) | Out-Null
        }
        $directStdout = (Get-Content -LiteralPath $directOut -Raw -ErrorAction SilentlyContinue) -as [string]
        $directStderr = (Get-Content -LiteralPath $directErr -Raw -ErrorAction SilentlyContinue) -as [string]
        $directReport = "Direct run exit=$($direct.ExitCode)`nDirect stdout:`n$directStdout`nDirect stderr:`n$directStderr"
    } catch {
        $directReport = "Direct run threw: $($_.Exception.Message)"
    } finally {
        Remove-Item $directOut, $directErr -ErrorAction SilentlyContinue
    }
    throw "Service $ServiceName did not reach Running (final status: $finalStatus).`nAudit log tail:`n$auditTail`nSCM event tail:`n$eventTail`n$directReport"
}

[PSCustomObject]@{
    serviceName = $ServiceName
    controlAddress = $ControlAddress
    controlPort = $ControlPort
    remoteAddress = $HostOnlySourceAddress
    firewallRule = $ruleName
    opensshBootstrapOnly = $true
} | ConvertTo-Json -Compress
