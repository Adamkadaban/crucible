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
$symbolPath = [Environment]::GetEnvironmentVariable("_NT_SYMBOL_PATH", "Machine")

$crucibleAdmin = Test-AccountExists -Name "CrucibleAdmin"
$crucibleUser = Test-AccountExists -Name "CrucibleUser"
$qemuAgentStatus = Get-ServiceStatusOrMissing -Name "qemu-ga"
$crucibleAgentStatus = Get-ServiceStatusOrMissing -Name "CrucibleGuestAgent"
$defenderRtp = Get-DefenderRealTimeProtection
$testSigning = Get-TestSigningEnabled

$checks = [ordered]@{
    cdbPath = $cdb
    windbgPath = $windbg
    symbolPath = $symbolPath
    crucibleAdminPresent = $crucibleAdmin
    crucibleUserPresent = $crucibleUser
    qemuAgentStatus = $qemuAgentStatus
    crucibleAgentStatus = $crucibleAgentStatus
    defenderRealTimeProtectionEnabled = $defenderRtp
    testSigningEnabled = $testSigning
}

$windbgHealthy = ($null -ne $cdb) -and ($null -ne $windbg) -and ($null -ne $symbolPath -and $symbolPath -ne "")
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
