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
            procmon = Find-ToolExecutable -FileNames @("Procmon64.exe", "Procmon.exe", "procmon64.exe", "procmon.exe")
            listdlls = Find-ToolExecutable -FileNames @("Listdlls64.exe", "Listdlls.exe")
            autorunsc = Find-ToolExecutable -FileNames @("autorunsc64.exe", "autorunsc.exe")
            sigcheck = Find-ToolExecutable -FileNames @("sigcheck64.exe", "sigcheck.exe")
        }
    }
}

function Install-ProcDump {
    $target = Join-Path $ToolsRoot "Sysinternals"
    if ($null -ne (Find-ToolExecutable -FileNames @("procdump64.exe", "procdump.exe"))) { return $false }
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    $payloadZip = Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=5' |
        Where-Object { $_.VolumeName -eq 'CRUCIBLE' } |
        ForEach-Object { Join-Path "$($_.DeviceID)\" "tools\Procdump.zip" } |
        Where-Object { Test-Path -LiteralPath $_ } |
        Select-Object -First 1
    if ($DryRun) {
        Write-Status "dry-run: install standalone ProcDump into $target"
        return $true
    }
    if ($payloadZip) {
        Expand-Archive -LiteralPath $payloadZip -DestinationPath $target -Force
        return $true
    }
    try {
        $tempDirectory = if ([string]::IsNullOrWhiteSpace($env:TEMP)) { "C:\ProgramData\Crucible\Temp" } else { $env:TEMP }
        New-Item -ItemType Directory -Force -Path $tempDirectory | Out-Null
        $zipPath = Join-Path $tempDirectory "Procdump.zip"
        Invoke-WebRequest -Uri "https://download.sysinternals.com/files/Procdump.zip" -OutFile $zipPath -UseBasicParsing -ErrorAction Stop
        Expand-Archive -LiteralPath $zipPath -DestinationPath $target -Force
        return $true
    } catch {
        if ($AllowSkipOnNetworkFailure) {
            Write-Status "ProcDump install unavailable ($($_.Exception.Message)); reporting unavailable"
            return $false
        }
        throw
    }
}

function Install-ProcMon {
    $target = Join-Path $ToolsRoot "Sysinternals"
    if ($null -ne (Find-ToolExecutable -FileNames @("Procmon64.exe", "Procmon.exe", "procmon64.exe", "procmon.exe"))) { return $false }
    $payloadZip = Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=5' |
        Where-Object { $_.VolumeName -eq 'CRUCIBLE' } |
        ForEach-Object { Join-Path "$($_.DeviceID)\" "tools\ProcessMonitor.zip" } |
        Where-Object { Test-Path -LiteralPath $_ } |
        Select-Object -First 1
    if ($DryRun) {
        Write-Status "dry-run: install standalone Process Monitor into $target"
        return $true
    }
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    if ($payloadZip) {
        Expand-Archive -LiteralPath $payloadZip -DestinationPath $target -Force
        return $true
    }
    try {
        $tempDirectory = if ([string]::IsNullOrWhiteSpace($env:TEMP)) { "C:\ProgramData\Crucible\Temp" } else { $env:TEMP }
        New-Item -ItemType Directory -Force -Path $tempDirectory | Out-Null
        $zipPath = Join-Path $tempDirectory "ProcessMonitor.zip"
        Invoke-WebRequest -Uri "https://download.sysinternals.com/files/ProcessMonitor.zip" -OutFile $zipPath -UseBasicParsing -ErrorAction Stop
        Expand-Archive -LiteralPath $zipPath -DestinationPath $target -Force
        return $true
    } catch {
        if ($AllowSkipOnNetworkFailure) {
            Write-Status "Process Monitor install unavailable ($($_.Exception.Message)); reporting unavailable"
            return $false
        }
        throw
    }
}

function Test-SysinternalsPresent {
    $report = Get-ToolReport
    return ($null -ne $report.sysinternals.handle) -and
        ($null -ne $report.sysinternals.strings) -and
        ($null -ne $report.sysinternals.tcpvcon) -and
        ($null -ne $report.sysinternals.procdump) -and
        ($null -ne $report.sysinternals.procmon) -and
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

New-Item -ItemType Directory -Force -Path $ToolsRoot | Out-Null
$sysinternalsAttempted = Install-Sysinternals
$procdumpAttempted = Install-ProcDump
$procmonAttempted = Install-ProcMon

$report = Get-ToolReport
$report.installedOrAttempted = [ordered]@{
    sysinternals = [bool]$sysinternalsAttempted
    procdump = [bool]$procdumpAttempted
    procmon = [bool]$procmonAttempted
}
$report | ConvertTo-Json -Depth 8 -Compress
