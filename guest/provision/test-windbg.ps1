param(
    [string]$SymbolCache = "C:\Symbols"
)

$ErrorActionPreference = "Stop"

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

$cdb = Find-DebuggerExecutable -FileNames @("cdb.exe")
$windbg = Find-DebuggerExecutable -FileNames @("windbg.exe", "WinDbgX.exe")
$kd = Find-DebuggerExecutable -FileNames @("kd.exe")
$kdnet = Find-DebuggerExecutable -FileNames @("kdnet.exe")
$gflags = Find-DebuggerExecutable -FileNames @("gflags.exe")
$expectedSymbolPath = "srv*$SymbolCache*https://msdl.microsoft.com/download/symbols"
$machineSymbolPath = [Environment]::GetEnvironmentVariable("_NT_SYMBOL_PATH", "Machine")
$altSymbolPath = [Environment]::GetEnvironmentVariable("_NT_ALT_SYMBOL_PATH", "Machine")
$symbolCacheWritable = Test-Path -LiteralPath $SymbolCache -PathType Container

$checks = [ordered]@{
    cdbPath = $cdb
    windbgPath = $windbg
    kdPath = $kd
    kdnetPath = $kdnet
    gflagsPath = $gflags
    symbolPath = $machineSymbolPath
    altSymbolPath = $altSymbolPath
    symbolCacheWritable = $symbolCacheWritable
    healthy = ($null -ne $cdb) -and ($null -ne $windbg) -and ($null -ne $kd) -and ($null -ne $kdnet) -and ($null -ne $gflags) -and ($machineSymbolPath -eq $expectedSymbolPath) -and ($altSymbolPath -eq $SymbolCache) -and $symbolCacheWritable
}

$checks | ConvertTo-Json -Compress

if (-not $checks.healthy) {
    exit 1
}
