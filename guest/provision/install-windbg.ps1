param(
    [string]$SymbolCache = "C:\Symbols",
    [string]$SdkInstallerUrl = "https://go.microsoft.com/fwlink/?linkid=2271337",
    [string]$SdkInstallerPath = "$env:TEMP\winsdksetup.exe",
    [switch]$DryRun,
    [switch]$AllowSkipOnNetworkFailure
)

$ErrorActionPreference = "Stop"

function Write-Status {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Message
    )

    [Console]::Error.WriteLine("[crucible] $Message")
}

function Find-CommandPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        return $null
    }

    return $command.Source
}

function Find-DebuggerExecutable {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$FileNames
    )

    foreach ($fileName in $FileNames) {
        $fromPath = Find-CommandPath -Name $fileName
        if ($null -ne $fromPath) {
            return $fromPath
        }
    }

    $candidateDirectories = @(
        "$env:ProgramFiles\Windows Kits\10\Debuggers\x64",
        "${env:ProgramFiles(x86)}\Windows Kits\10\Debuggers\x64",
        "$env:LOCALAPPDATA\Microsoft\WindowsApps"
    )

    $windowsApps = "$env:ProgramFiles\WindowsApps"
    if (-not [string]::IsNullOrWhiteSpace($windowsApps) -and (Test-Path -LiteralPath $windowsApps)) {
        $candidateDirectories += Get-ChildItem -LiteralPath $windowsApps -Directory -Filter "Microsoft.WinDbg_*" -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty FullName
    }

    foreach ($directory in $candidateDirectories) {
        if ([string]::IsNullOrWhiteSpace($directory) -or -not (Test-Path -LiteralPath $directory)) {
            continue
        }

        foreach ($fileName in $FileNames) {
            $candidate = Join-Path -Path $directory -ChildPath $fileName
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                return $candidate
            }
        }
    }

    return $null
}

function Install-WithWinget {
    $winget = Find-CommandPath -Name "winget.exe"
    if ($null -eq $winget) {
        return $false
    }

    $wingetArguments = @(
        "install",
        "--id",
        "Microsoft.WinDbg",
        "--exact",
        "--accept-package-agreements",
        "--accept-source-agreements",
        "--disable-interactivity"
    )

    Write-Status "installing WinDbg with winget"
    if ($DryRun) {
        Write-Status "dry-run: $winget $($wingetArguments -join ' ')"
        return $true
    }

    & $winget @wingetArguments
    if ($LASTEXITCODE -ne 0) {
        throw "winget install Microsoft.WinDbg failed with exit code $LASTEXITCODE"
    }

    return $true
}

function Install-WithSdkDebuggingTools {
    Write-Status "installing Windows SDK Debugging Tools fallback"
    if ($DryRun) {
        Write-Status "dry-run: download $SdkInstallerUrl to $SdkInstallerPath"
        Write-Status "dry-run: $SdkInstallerPath /features OptionId.WindowsDesktopDebuggers /quiet /norestart"
        return
    }

    # -ErrorAction Stop forces Invoke-WebRequest to throw a terminating
    # error on DNS failure (otherwise it can write to the error stream
    # without unwinding the stack on some PS5.1 builds, defeating the
    # outer try/catch that maps offline runs to exit 75).
    Invoke-WebRequest -Uri $SdkInstallerUrl -OutFile $SdkInstallerPath -UseBasicParsing -ErrorAction Stop
    & $SdkInstallerPath "/features" "OptionId.WindowsDesktopDebuggers" "/quiet" "/norestart"
    if ($LASTEXITCODE -ne 0) {
        throw "Windows SDK Debugging Tools installation failed with exit code $LASTEXITCODE"
    }
}

function Set-SymbolPath {
    param(
        [Parameter(Mandatory = $true)]
        [string]$CachePath
    )

    $symbolPath = "srv*$CachePath*https://msdl.microsoft.com/download/symbols"

    Write-Status "configuring symbol path: $symbolPath"
    if (-not $DryRun) {
        New-Item -ItemType Directory -Path $CachePath -Force | Out-Null
        [Environment]::SetEnvironmentVariable("_NT_SYMBOL_PATH", $symbolPath, "Machine")
        [Environment]::SetEnvironmentVariable("_NT_ALT_SYMBOL_PATH", $CachePath, "Machine")
        $env:_NT_SYMBOL_PATH = $symbolPath
        $env:_NT_ALT_SYMBOL_PATH = $CachePath
    }

    return $symbolPath
}

function Test-WinDbgReadiness {
    param(
        [Parameter(Mandatory = $true)]
        [string]$ExpectedSymbolPath,

        [Parameter(Mandatory = $true)]
        [string]$ExpectedAltSymbolPath
    )

    $cdb = Find-DebuggerExecutable -FileNames @("cdb.exe")
    $windbg = Find-DebuggerExecutable -FileNames @("windbg.exe", "WinDbgX.exe")

    if ($null -eq $cdb) {
        throw "cdb.exe is not discoverable after debugger installation"
    }
    if ($null -eq $windbg) {
        throw "windbg.exe is not discoverable after debugger installation"
    }

    $machineSymbolPath = [Environment]::GetEnvironmentVariable("_NT_SYMBOL_PATH", "Machine")
    if ($machineSymbolPath -ne $ExpectedSymbolPath) {
        throw "machine _NT_SYMBOL_PATH is not configured as expected"
    }
    $machineAltSymbolPath = [Environment]::GetEnvironmentVariable("_NT_ALT_SYMBOL_PATH", "Machine")
    if ($machineAltSymbolPath -ne $ExpectedAltSymbolPath) {
        throw "machine _NT_ALT_SYMBOL_PATH is not configured as expected"
    }

    return [ordered]@{
        cdbPath = $cdb
        windbgPath = $windbg
        symbolPath = $machineSymbolPath
        altSymbolPath = $machineAltSymbolPath
    }
}

function Test-DebuggerToolingPresent {
    $cdb = Find-DebuggerExecutable -FileNames @("cdb.exe")
    $windbg = Find-DebuggerExecutable -FileNames @("windbg.exe", "WinDbgX.exe")

    return ($null -ne $cdb) -and ($null -ne $windbg)
}

if (-not (Test-DebuggerToolingPresent)) {
    try {
        if (-not (Install-WithWinget)) {
            Install-WithSdkDebuggingTools
        }
        if (-not $DryRun -and -not (Test-DebuggerToolingPresent)) {
            Write-Status "debugger tooling is still incomplete after winget; installing SDK Debugging Tools"
            Install-WithSdkDebuggingTools
        }
    } catch {
        if ($AllowSkipOnNetworkFailure) {
            Write-Status "WinDbg installer unreachable ($($_.Exception.Message)); skipping per -AllowSkipOnNetworkFailure"
            [ordered]@{
                cdbPath = $null
                windbgPath = $null
                symbolPath = $null
                altSymbolPath = $null
                skipped = $true
                reason = $_.Exception.Message
            } | ConvertTo-Json -Compress
            # Exit 75 (EX_TEMPFAIL) signals an opt-in skip rather than a hard
            # failure. The QGA executor maps this to a succeeded-but-skipped
            # stage result so downstream stages (e.g. test-health) can branch.
            exit 75
        }
        throw
    }
} else {
    Write-Status "WinDbg and CDB are already installed"
}

$configuredSymbolPath = Set-SymbolPath -CachePath $SymbolCache

if ($DryRun) {
    Write-Status "dry-run: readiness check would verify cdb.exe, windbg.exe, and symbol path"
    exit 0
}

$readiness = Test-WinDbgReadiness -ExpectedSymbolPath $configuredSymbolPath -ExpectedAltSymbolPath $SymbolCache
$readiness | ConvertTo-Json -Compress
