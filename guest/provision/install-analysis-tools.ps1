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
            handle = Find-ToolExecutable -FileNames @("handle64.exe", "handle.exe")
            strings = Find-ToolExecutable -FileNames @("strings64.exe", "strings.exe")
            tcpview = Find-ToolExecutable -FileNames @("Tcpview.exe", "Tcpview64.exe")
            tcpvcon = Find-ToolExecutable -FileNames @("tcpvcon64.exe", "tcpvcon.exe")
            procdump = Find-ToolExecutable -FileNames @("procdump64.exe", "procdump.exe")
            listdlls = Find-ToolExecutable -FileNames @("Listdlls64.exe", "Listdlls.exe")
            autorunsc = Find-ToolExecutable -FileNames @("autorunsc64.exe", "autorunsc.exe")
            sigcheck = Find-ToolExecutable -FileNames @("sigcheck64.exe", "sigcheck.exe")
        }
        malwareTools = [ordered]@{
            x64dbg = Find-ToolExecutable -FileNames @("x64dbg.exe")
        }
    }
}

function Test-SysinternalsPresent {
    $report = Get-ToolReport
    return ($null -ne $report.sysinternals.handle) -and
        ($null -ne $report.sysinternals.strings) -and
        ($null -ne $report.sysinternals.tcpvcon) -and
        ($null -ne $report.sysinternals.procdump) -and
        ($null -ne $report.sysinternals.listdlls) -and
        ($null -ne $report.sysinternals.autorunsc) -and
        ($null -ne $report.sysinternals.sigcheck)
}

function Install-Sysinternals {
    $target = Join-Path $ToolsRoot "Sysinternals"
    if (Test-SysinternalsPresent) { return $false }
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    $payloadZip = Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=5' |
        Where-Object { $_.VolumeName -eq 'CRUCIBLE' } |
        ForEach-Object { Join-Path "$($_.DeviceID)\" "tools\SysinternalsSuite.zip" } |
        Where-Object { Test-Path -LiteralPath $_ } |
        Select-Object -First 1
    if ($DryRun) {
        Write-Status "dry-run: download $SysinternalsUrl to $SysinternalsZipPath and expand to $target"
        return $true
    }
    try {
        if ($payloadZip) {
            Expand-Archive -LiteralPath $payloadZip -DestinationPath $target -Force
        } else {
            Invoke-WebRequest -Uri $SysinternalsUrl -OutFile $SysinternalsZipPath -UseBasicParsing -ErrorAction Stop
            Expand-Archive -LiteralPath $SysinternalsZipPath -DestinationPath $target -Force
        }
        return $true
    } catch {
        if ($AllowSkipOnNetworkFailure) {
            Write-Status "Sysinternals install unavailable ($($_.Exception.Message)); reporting unavailable"
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
        if ($LASTEXITCODE -eq 0) { return $true }
        if ($AllowSkipOnNetworkFailure) {
            Write-Status "$Name install skipped (winget exit $LASTEXITCODE)"
            return $false
        }
        throw "$Name winget install failed with exit code $LASTEXITCODE"
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
