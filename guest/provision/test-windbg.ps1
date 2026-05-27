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

$cdb = Find-DebuggerExecutable -FileNames @("cdb.exe")
$windbg = Find-DebuggerExecutable -FileNames @("windbg.exe", "WinDbgX.exe")
$expectedSymbolPath = "srv*$SymbolCache*https://msdl.microsoft.com/download/symbols"
$machineSymbolPath = [Environment]::GetEnvironmentVariable("_NT_SYMBOL_PATH", "Machine")
$altSymbolPath = [Environment]::GetEnvironmentVariable("_NT_ALT_SYMBOL_PATH", "Machine")

$checks = [ordered]@{
    cdbPath = $cdb
    windbgPath = $windbg
    symbolPath = $machineSymbolPath
    altSymbolPath = $altSymbolPath
    healthy = ($null -ne $cdb) -and ($null -ne $windbg) -and ($machineSymbolPath -eq $expectedSymbolPath) -and ($altSymbolPath -eq $SymbolCache)
}

$checks | ConvertTo-Json -Compress

if (-not $checks.healthy) {
    exit 1
}
