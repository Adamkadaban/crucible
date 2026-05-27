param(
    [string]$SymbolCache = "C:\Symbols",
    [string]$SdkInstallerUrl = "https://go.microsoft.com/fwlink/?linkid=2271337",
    [string]$SdkInstallerPath = "$env:TEMP\winsdksetup.exe",
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

function Write-Status {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Message
    )

    Write-Host "[crucible] $Message"
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

    $roots = @(
        "$env:ProgramFiles\Windows Kits\10\Debuggers\x64",
        "${env:ProgramFiles(x86)}\Windows Kits\10\Debuggers\x64",
        "$env:LOCALAPPDATA\Microsoft\WindowsApps",
        "$env:ProgramFiles\WindowsApps"
    )

    foreach ($root in $roots) {
        if ([string]::IsNullOrWhiteSpace($root) -or -not (Test-Path -LiteralPath $root)) {
            continue
        }

        foreach ($fileName in $FileNames) {
            $match = Get-ChildItem -LiteralPath $root -Filter $fileName -Recurse -ErrorAction SilentlyContinue |
                Select-Object -First 1
            if ($null -ne $match) {
                return $match.FullName
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

    Invoke-WebRequest -Uri $SdkInstallerUrl -OutFile $SdkInstallerPath -UseBasicParsing
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
        [string]$ExpectedSymbolPath
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

    return [ordered]@{
        cdbPath = $cdb
        windbgPath = $windbg
        symbolPath = $machineSymbolPath
    }
}

$beforeCdb = Find-DebuggerExecutable -FileNames @("cdb.exe")
$beforeWinDbg = Find-DebuggerExecutable -FileNames @("windbg.exe", "WinDbgX.exe")

if ($null -eq $beforeCdb -or $null -eq $beforeWinDbg) {
    if (-not (Install-WithWinget)) {
        Install-WithSdkDebuggingTools
    }
    if (-not $DryRun -and $null -eq (Find-DebuggerExecutable -FileNames @("cdb.exe"))) {
        Write-Status "CDB is still missing after winget; installing SDK Debugging Tools"
        Install-WithSdkDebuggingTools
    }
} else {
    Write-Status "WinDbg and CDB are already installed"
}

$configuredSymbolPath = Set-SymbolPath -CachePath $SymbolCache

if ($DryRun) {
    Write-Status "dry-run: readiness check would verify cdb.exe, windbg.exe, and symbol path"
    exit 0
}

$readiness = Test-WinDbgReadiness -ExpectedSymbolPath $configuredSymbolPath
$readiness | ConvertTo-Json -Compress
