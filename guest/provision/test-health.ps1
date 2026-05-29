param(
    [switch]$AllowMissingWinDbg,
    [switch]$AllowDefenderEnabled
)

$ErrorActionPreference = "Stop"

# Aggregated guest-health snapshot. Provisioning runs this after WinDbg,
# Defender / code-integrity policy, accounts, and the guest agent are
# installed to confirm everything is in the expected state before a clean
# snapshot is taken. Exit non-zero (with the offending checks visible in
# JSON) so the lifecycle manager surfaces the failure instead of capturing
# an unhealthy baseline.

function Test-AccountExists {
    param([Parameter(Mandatory = $true)][string]$Name)
    try {
        $null = Get-LocalUser -Name $Name -ErrorAction Stop
        return $true
    } catch {
        return $false
    }
}

function Get-ServiceStatusOrMissing {
    param([Parameter(Mandatory = $true)][string]$Name)
    $svc = Get-Service -Name $Name -ErrorAction SilentlyContinue
    if ($null -eq $svc) { return "missing" }
    return $svc.Status.ToString()
}

function Find-DebuggerExecutable {
    param([Parameter(Mandatory = $true)][string[]]$FileNames)
    foreach ($name in $FileNames) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if ($null -ne $cmd) { return $cmd.Source }
    }
    $candidates = @(
        "$env:ProgramFiles\Windows Kits\10\Debuggers\x64",
        "${env:ProgramFiles(x86)}\Windows Kits\10\Debuggers\x64",
        "$env:LOCALAPPDATA\Microsoft\WindowsApps"
    )
    $windowsApps = "$env:ProgramFiles\WindowsApps"
    if (-not [string]::IsNullOrWhiteSpace($windowsApps) -and (Test-Path -LiteralPath $windowsApps)) {
        $candidates += Get-ChildItem -LiteralPath $windowsApps -Directory -Filter "Microsoft.WinDbg_*" -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty FullName
    }
    foreach ($dir in $candidates) {
        if ([string]::IsNullOrWhiteSpace($dir) -or -not (Test-Path -LiteralPath $dir)) { continue }
        foreach ($name in $FileNames) {
            $candidate = Join-Path -Path $dir -ChildPath $name
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
        }
    }
    return $null
}

function Find-ToolExecutable {
    param([Parameter(Mandatory = $true)][string[]]$FileNames)
    $toolDirs = @(
        "C:\Tools",
        "C:\Tools\Sysinternals",
        "C:\Tools\Malware"
    )
    foreach ($name in $FileNames) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if ($null -ne $cmd) { return $cmd.Source }
    }
    foreach ($dir in $toolDirs) {
        if ([string]::IsNullOrWhiteSpace($dir) -or -not (Test-Path -LiteralPath $dir)) { continue }
        foreach ($name in $FileNames) {
            $candidate = Join-Path -Path $dir -ChildPath $name
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
        }
    }
    return $null
}

function Get-DefenderRealTimeProtection {
    try {
        $status = Get-MpComputerStatus -ErrorAction Stop
        return [bool]$status.RealTimeProtectionEnabled
    } catch {
        return $null
    }
}

function Get-TestSigningEnabled {
    try {
        $bcd = & bcdedit /enum '{current}' 2>$null
        if ($LASTEXITCODE -ne 0) { return $null }
        return [bool]($bcd | Select-String -Pattern 'testsigning\s+Yes' -SimpleMatch:$false -Quiet)
    } catch {
        return $null
    }
}

$cdb = Find-DebuggerExecutable -FileNames @("cdb.exe")
$windbg = Find-DebuggerExecutable -FileNames @("windbg.exe", "WinDbgX.exe")
$kd = Find-DebuggerExecutable -FileNames @("kd.exe")
$kdnet = Find-DebuggerExecutable -FileNames @("kdnet.exe")
$gflags = Find-DebuggerExecutable -FileNames @("gflags.exe")
$symbolPath = [Environment]::GetEnvironmentVariable("_NT_SYMBOL_PATH", "Machine")
$symbolCache = [Environment]::GetEnvironmentVariable("_NT_ALT_SYMBOL_PATH", "Machine")
$symbolCacheWritable = $false
if (-not [string]::IsNullOrWhiteSpace($symbolCache)) {
    try {
        New-Item -ItemType Directory -Force -Path $symbolCache | Out-Null
        $probe = Join-Path $symbolCache "crucible-symbol-cache.probe"
        Set-Content -LiteralPath $probe -Value "ok" -Force
        Remove-Item -LiteralPath $probe -Force
        $symbolCacheWritable = $true
    } catch {
        $symbolCacheWritable = $false
    }
}
$sysinternals = [ordered]@{
    procmon = Find-ToolExecutable -FileNames @("Procmon64.exe", "Procmon.exe")
    procexp = Find-ToolExecutable -FileNames @("procexp64.exe", "procexp.exe")
    handle = Find-ToolExecutable -FileNames @("handle64.exe", "handle.exe")
    strings = Find-ToolExecutable -FileNames @("strings64.exe", "strings.exe")
    tcpview = Find-ToolExecutable -FileNames @("Tcpview.exe", "Tcpview64.exe")
}
$malwareTools = [ordered]@{
    x64dbg = Find-ToolExecutable -FileNames @("x64dbg.exe")
    cutter = Find-ToolExecutable -FileNames @("cutter.exe")
    ghidra = Find-ToolExecutable -FileNames @("ghidraRun.bat")
    peStudio = Find-ToolExecutable -FileNames @("pestudio.exe")
}

$crucibleAdmin = Test-AccountExists -Name "CrucibleAdmin"
$crucibleUser = Test-AccountExists -Name "CrucibleUser"
$qemuAgentStatus = Get-ServiceStatusOrMissing -Name "qemu-ga"
$crucibleAgentStatus = Get-ServiceStatusOrMissing -Name "CrucibleGuestAgent"
$defenderRtp = Get-DefenderRealTimeProtection
$testSigning = Get-TestSigningEnabled

$checks = [ordered]@{
    cdbPath = $cdb
    windbgPath = $windbg
    kdPath = $kd
    kdnetPath = $kdnet
    gflagsPath = $gflags
    symbolPath = $symbolPath
    symbolCachePath = $symbolCache
    symbolCacheWritable = $symbolCacheWritable
    sysinternals = $sysinternals
    malwareTools = $malwareTools
    crucibleAdminPresent = $crucibleAdmin
    crucibleUserPresent = $crucibleUser
    qemuAgentStatus = $qemuAgentStatus
    crucibleAgentStatus = $crucibleAgentStatus
    defenderRealTimeProtectionEnabled = $defenderRtp
    testSigningEnabled = $testSigning
}

$windbgHealthy = ($null -ne $cdb) -and ($null -ne $windbg) -and ($null -ne $kd) -and ($null -ne $kdnet) -and ($null -ne $gflags) -and ($null -ne $symbolPath -and $symbolPath -ne "") -and $symbolCacheWritable
if ($AllowMissingWinDbg) {
    # The plan may opt-in to allow WinDbg to be absent (e.g. provisioning ran
    # on an isolated network and install-windbg skipped). Treat WinDbg as
    # optional but still report the underlying state.
    $windbgHealthy = $true
}

$defenderGate = $defenderRtp -eq $false
if ($AllowDefenderEnabled) {
    # Windows Tamper Protection prevents programmatic Defender disable via
    # registry / Set-MpPreference even from LocalSystem. Provisioning may
    # opt to surface RTP state without failing the health check; operators
    # can disable Tamper Protection offline via an OEM image.
    $defenderGate = $true
}

$healthy = (
    $windbgHealthy -and
    $crucibleAdmin -and
    $crucibleUser -and
    $qemuAgentStatus -eq "Running" -and
    $crucibleAgentStatus -eq "Running" -and
    $defenderGate -and
    # Matches the policy default (`bcdedit /set testsigning off`). Operators
    # who enable test signing through a custom policy should override this
    # script accordingly.
    ($testSigning -eq $false)
)

$checks.healthy = $healthy
$checks | ConvertTo-Json -Compress

if (-not $healthy) {
    exit 1
}
