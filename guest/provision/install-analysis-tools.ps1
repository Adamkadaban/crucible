param(
    [string]$ToolsRoot = "C:\Tools",
    [string]$SysinternalsUrl = "https://download.sysinternals.com/files/SysinternalsSuite.zip",
    [string]$SysinternalsZipPath,
    [bool]$AllowSkipOnNetworkFailure = $true,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($SysinternalsZipPath)) {
    $tempDirectory = if ([string]::IsNullOrWhiteSpace($env:TEMP)) { "C:\ProgramData\Crucible\Temp" } else { $env:TEMP }
    New-Item -ItemType Directory -Force -Path $tempDirectory | Out-Null
    $SysinternalsZipPath = Join-Path $tempDirectory "SysinternalsSuite.zip"
}

function Write-Status {
    param([Parameter(Mandatory = $true)][string]$Message)
    [Console]::Error.WriteLine("[crucible] $Message")
}

function Find-ToolExecutable {
    param([Parameter(Mandatory = $true)][string[]]$FileNames)
    $dirs = @(
        $ToolsRoot,
        (Join-Path $ToolsRoot "Sysinternals"),
        (Join-Path $ToolsRoot "Malware")
    )
    foreach ($name in $FileNames) {
        $cmd = Get-Command $name -ErrorAction SilentlyContinue
        if ($null -ne $cmd) { return $cmd.Source }
    }
    foreach ($dir in $dirs) {
        if ([string]::IsNullOrWhiteSpace($dir) -or -not (Test-Path -LiteralPath $dir)) { continue }
        foreach ($name in $FileNames) {
            $candidate = Join-Path -Path $dir -ChildPath $name
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
        }
    }
    return $null
}

function Get-ToolReport {
    return [ordered]@{
        sysinternals = [ordered]@{
            procmon = Find-ToolExecutable -FileNames @("Procmon64.exe", "Procmon.exe")
            procexp = Find-ToolExecutable -FileNames @("procexp64.exe", "procexp.exe")
            handle = Find-ToolExecutable -FileNames @("handle64.exe", "handle.exe")
            strings = Find-ToolExecutable -FileNames @("strings64.exe", "strings.exe")
            tcpview = Find-ToolExecutable -FileNames @("Tcpview.exe", "Tcpview64.exe")
        }
        malwareTools = [ordered]@{
            x64dbg = Find-ToolExecutable -FileNames @("x64dbg.exe")
        }
    }
}

function Test-SysinternalsPresent {
    $report = Get-ToolReport
    return ($null -ne $report.sysinternals.procmon) -and
        ($null -ne $report.sysinternals.procexp) -and
        ($null -ne $report.sysinternals.handle) -and
        ($null -ne $report.sysinternals.strings)
}

function Install-Sysinternals {
    $target = Join-Path $ToolsRoot "Sysinternals"
    if (Test-SysinternalsPresent) { return $false }
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    if ($DryRun) {
        Write-Status "dry-run: download $SysinternalsUrl to $SysinternalsZipPath and expand to $target"
        return $true
    }
    try {
        Invoke-WebRequest -Uri $SysinternalsUrl -OutFile $SysinternalsZipPath -UseBasicParsing -ErrorAction Stop
        Expand-Archive -LiteralPath $SysinternalsZipPath -DestinationPath $target -Force
        return $true
    } catch {
        if ($AllowSkipOnNetworkFailure) {
            Write-Status "Sysinternals installer unreachable ($($_.Exception.Message)); reporting unavailable"
            return $false
        }
        throw
    }
}

function Try-WingetInstall {
    param(
        [Parameter(Mandatory = $true)][string]$PackageId,
        [Parameter(Mandatory = $true)][string]$Name
    )
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if ($null -eq $winget) { return $false }
    if ($DryRun) {
        Write-Status "dry-run: winget install $PackageId ($Name)"
        return $true
    }
    try {
        & $winget.Source install --id $PackageId --exact --accept-package-agreements --accept-source-agreements --disable-interactivity
        return $LASTEXITCODE -eq 0
    } catch {
        if ($AllowSkipOnNetworkFailure) {
            Write-Status "$Name install skipped ($($_.Exception.Message))"
            return $false
        }
        throw
    }
}

New-Item -ItemType Directory -Force -Path $ToolsRoot | Out-Null
$sysinternalsAttempted = Install-Sysinternals
$x64dbgAttempted = Try-WingetInstall -PackageId "x64dbg.x64dbg" -Name "x64dbg"

$report = Get-ToolReport
$report.installedOrAttempted = [ordered]@{
    sysinternals = [bool]$sysinternalsAttempted
    x64dbg = [bool]$x64dbgAttempted
}
$report | ConvertTo-Json -Depth 8 -Compress
