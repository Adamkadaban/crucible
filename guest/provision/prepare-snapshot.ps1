param(
    [Parameter(Mandatory = $true)][string]$SnapshotName
)

$ErrorActionPreference = "Stop"

# Quiesce transient guest state so the host can take a clean qcow2 snapshot
# that future restores boot from deterministically. Anything noisy or
# transient (event logs, temp files, swap, Defender / WER caches) gets
# cleaned. Per-snapshot metadata is written to a well-known marker so
# host-side tooling can confirm the snapshot was prepared by this script.

function Invoke-Quietly {
    param([Parameter(Mandatory = $true)][scriptblock]$Block)
    try { & $Block } catch { }
}

# 1. Stop transient services that hold open handles or pending writes.
$servicesToStop = @(
    "wuauserv",            # Windows Update
    "DiagTrack",           # Connected User Experiences and Telemetry
    "WerSvc",              # Windows Error Reporting
    "SysMain",             # Superfetch
    "WSearch"              # Windows Search indexer
)
foreach ($svc in $servicesToStop) {
    Invoke-Quietly {
        $existing = Get-Service -Name $svc -ErrorAction Stop
        if ($existing.Status -eq "Running") {
            Stop-Service -Name $svc -Force -ErrorAction Stop
        }
    }
}

# 2. Clear temp directories.
$tempPaths = @(
    "$env:windir\Temp",
    "$env:LOCALAPPDATA\Temp",
    "C:\Users\CrucibleAdmin\AppData\Local\Temp",
    "C:\Users\CrucibleUser\AppData\Local\Temp"
)
foreach ($path in $tempPaths) {
    Invoke-Quietly {
        if (Test-Path -LiteralPath $path) {
            Get-ChildItem -LiteralPath $path -Force -ErrorAction SilentlyContinue |
                Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

# 3. Clear Windows event logs so the snapshot starts from an empty slate.
Invoke-Quietly {
    & wevtutil.exe el | ForEach-Object { & wevtutil.exe cl $_ } | Out-Null
}

# 4. Flush filesystem buffers.
Invoke-Quietly { & fsutil.exe behavior set DisableLastAccess 1 | Out-Null }
Invoke-Quietly { & cmd.exe /c "sync" | Out-Null }

# 5. Write the snapshot metadata marker.
$markerDir = "C:\ProgramData\Crucible"
if (-not (Test-Path -LiteralPath $markerDir)) {
    New-Item -ItemType Directory -Path $markerDir -Force | Out-Null
}
$marker = [ordered]@{
    snapshotName = $SnapshotName
    preparedAt = (Get-Date).ToString("o")
    hostName = [System.Environment]::MachineName
    osVersion = [System.Environment]::OSVersion.VersionString
    powershellVersion = $PSVersionTable.PSVersion.ToString()
}
$markerPath = Join-Path -Path $markerDir -ChildPath "snapshot-prepared.json"
$marker | ConvertTo-Json -Compress | Set-Content -LiteralPath $markerPath -Encoding ASCII

[ordered]@{
    snapshotName = $SnapshotName
    quiesced = $true
    markerPath = $markerPath
} | ConvertTo-Json -Compress
