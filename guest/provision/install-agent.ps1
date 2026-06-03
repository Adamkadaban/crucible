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
    [int]$ControlPort,

    [Parameter()]
    [string]$StandardUsername = "CrucibleUser",

    [Parameter()]
    [string]$AdminUsername = "CrucibleAdmin"
)

$ErrorActionPreference = "Stop"
trap {
    $invocation = $_.InvocationInfo
    $line = if ($invocation) { $invocation.Line } else { "(unknown)" }
    throw "install-agent.ps1 failed at line $($invocation.ScriptLineNumber): $line`n$($_.Exception.Message)"
}

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

function Require-SecretEnvironment {
    param([Parameter(Mandatory = $true)][string]$Name)
    $value = [Environment]::GetEnvironmentVariable($Name, "Process")
    if ([string]::IsNullOrWhiteSpace($value)) {
        throw "Missing required secret environment variable: $Name"
    }
    return $value
}

function Remove-ServiceRegistration {
    param([Parameter(Mandatory = $true)][string]$Name)
    $sc = "$env:SystemRoot\System32\sc.exe"
    $proc = Start-Process -FilePath $sc -ArgumentList @("delete", $Name) -Wait -PassThru -NoNewWindow
    if ($proc.ExitCode -ne 0 -and $proc.ExitCode -ne 1060) {
        throw "sc.exe delete failed (exit $($proc.ExitCode))"
    }
}

function Invoke-NativeQuiet {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [int[]]$AllowedExitCodes = @(0)
    )
    $proc = Start-Process -FilePath $FilePath -ArgumentList $Arguments -Wait -PassThru -NoNewWindow
    if ($AllowedExitCodes -notcontains $proc.ExitCode) {
        throw "$FilePath failed (exit $($proc.ExitCode))"
    }
}

function Set-SystemAndAdministratorsOnlyAcl {
    param([Parameter(Mandatory = $true)][string]$Path)
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true, $false)
    $acl.Access | ForEach-Object { $acl.RemoveAccessRule($_) | Out-Null }
    foreach ($identity in @("NT AUTHORITY\SYSTEM", "BUILTIN\Administrators")) {
        $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, "FullControl", "Allow")
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Grant-IdentityModifyAcl {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Identity
    )
    $acl = Get-Acl -LiteralPath $Path
    $acl.SetAccessRuleProtection($true, $false)
    $acl.Access | ForEach-Object { $acl.RemoveAccessRule($_) | Out-Null }
    foreach ($baseIdentity in @("NT AUTHORITY\SYSTEM", "BUILTIN\Administrators")) {
        $baseRule = New-Object System.Security.AccessControl.FileSystemAccessRule($baseIdentity, "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow")
        $acl.AddAccessRule($baseRule)
    }
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        $Identity,
        "Modify",
        "ContainerInherit,ObjectInherit",
        "None",
        "Allow"
    )
    $acl.AddAccessRule($rule)
    Set-Acl -LiteralPath $Path -AclObject $acl
}

function Remove-ExistingStagedFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    try {
        Set-SystemAndAdministratorsOnlyAcl -Path $Path
        Remove-Item -LiteralPath $Path -Force -ErrorAction Stop
    } catch {
        throw "Failed to remove existing staged file ${Path}: $($_.Exception.Message)"
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
New-Item -ItemType Directory -Force -Path "C:\ProgramData\Crucible\Agent" | Out-Null
$tempDirectory = if ([string]::IsNullOrWhiteSpace($env:TEMP)) { "C:\ProgramData\Crucible\Temp" } else { $env:TEMP }
New-Item -ItemType Directory -Force -Path $tempDirectory | Out-Null
$execDirectory = "C:\ProgramData\Crucible\Exec"
New-Item -ItemType Directory -Force -Path $execDirectory | Out-Null
$standardExecDirectory = Join-Path $execDirectory "standard"
$adminExecDirectory = Join-Path $execDirectory "admin"
New-Item -ItemType Directory -Force -Path $standardExecDirectory, $adminExecDirectory | Out-Null
Grant-IdentityModifyAcl -Path $standardExecDirectory -Identity $StandardUsername
Grant-IdentityModifyAcl -Path $adminExecDirectory -Identity $AdminUsername

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
    Remove-ServiceRegistration -Name $ServiceName
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
foreach ($target in @($caCertificate, $serverCertificate, $serverPrivateKey)) {
    Remove-ExistingStagedFile -Path $target
}
Copy-Item -LiteralPath $payloadCa -Destination $caCertificate -Force
Copy-Item -LiteralPath $payloadServerCert -Destination $serverCertificate -Force
Copy-Item -LiteralPath $payloadServerKey -Destination $serverPrivateKey -Force

$credentialsPath = "C:\ProgramData\Crucible\Agent\credentials.json"
$credentials = [ordered]@{
    standard = [ordered]@{
        username = $StandardUsername
        password = (Require-SecretEnvironment -Name "CRUCIBLE_STANDARD_PASSWORD")
    }
    admin = [ordered]@{
        username = $AdminUsername
        password = (Require-SecretEnvironment -Name "CRUCIBLE_ADMIN_PASSWORD")
    }
}
$credentialsJson = $credentials | ConvertTo-Json -Depth 4
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($credentialsPath, $credentialsJson, $utf8NoBom)
$credAcl = Get-Acl -LiteralPath $credentialsPath
$credAcl.SetAccessRuleProtection($true, $false)
$credAcl.Access | ForEach-Object { $credAcl.RemoveAccessRule($_) | Out-Null }
foreach ($identity in @("NT AUTHORITY\SYSTEM", "BUILTIN\Administrators")) {
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, "FullControl", "Allow")
    $credAcl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $credentialsPath -AclObject $credAcl

# Lock down the mTLS private key to SYSTEM + Administrators while keeping
# FullControl so future re-provision runs can overwrite the file cleanly.
Set-SystemAndAdministratorsOnlyAcl -Path $serverPrivateKey

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
$smokeOut = Join-Path $tempDirectory "crucible-agent-smoke.out"
$smokeErr = Join-Path $tempDirectory "crucible-agent-smoke.err"
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
    "--credentials", ('"{0}"' -f $credentialsPath),
    "--exec-dir", ('"{0}"' -f $execDirectory),
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
    Remove-ServiceRegistration -Name $ServiceName
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
$cmdPath = Join-Path $tempDirectory "crucible-install-agent-$([guid]::NewGuid().ToString('n')).cmd"
$cmdContent = @(
    "@echo off",
    ('"{0}" create {1} binPath= "{2}" start= auto DisplayName= "Crucible Guest Agent"' -f $scExe, $ServiceName, $cmdBinPath),
    "exit /b %ERRORLEVEL%"
)
$cmdContent | Set-Content -LiteralPath $cmdPath -Encoding ASCII
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
    $directOut = Join-Path $tempDirectory "crucible-agent-direct.out"
    $directErr = Join-Path $tempDirectory "crucible-agent-direct.err"
    Remove-Item $directOut, $directErr -ErrorAction SilentlyContinue
    $directArgs = @(
        "run",
        "--listen", $listenAddress,
        "--tls-cert", $serverCertificate,
        "--tls-key", $serverPrivateKey,
        "--tls-client-ca", $caCertificate,
        "--staging-dir", "C:\ProgramData\Crucible\staging",
        "--credentials", $credentialsPath,
        "--exec-dir", $execDirectory,
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
