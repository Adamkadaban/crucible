param(
    [Parameter(Mandatory = $true)][string]$SnapshotName
)

$ErrorActionPreference = "Stop"

# Quiesce transient guest state so the host can take a clean qcow2 snapshot
# that future restores boot from deterministically. Anything noisy or
# transient (event logs, temp files, Defender / WER caches) gets cleaned.
# Per-snapshot metadata is written to a well-known marker so host-side
# tooling can confirm the snapshot was prepared by this script.

$failures = New-Object System.Collections.Generic.List[string]

function Invoke-Step {
    param(
        [Parameter(Mandatory = $true)][string]$Description,
        [Parameter(Mandatory = $true)][scriptblock]$Block
    )
    try {
        & $Block
    } catch {
        $failures.Add("$Description: $($_.Exception.Message)") | Out-Null
    }
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
    Invoke-Step "stop service $svc" {
        $existing = Get-Service -Name $svc -ErrorAction SilentlyContinue
        if ($null -eq $existing) { return }
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
    Invoke-Step "clear $path" {
        if (Test-Path -LiteralPath $path) {
            Get-ChildItem -LiteralPath $path -Force -ErrorAction SilentlyContinue |
                Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

# 3. Clear Windows event logs so the snapshot starts from an empty slate.
Invoke-Step "clear event logs" {
    $logs = & wevtutil.exe el
    if ($LASTEXITCODE -ne 0) {
        throw "wevtutil el exited with code $LASTEXITCODE"
    }
    foreach ($log in $logs) {
        & wevtutil.exe cl $log 2>$null | Out-Null
    }
}

# 4. Write the snapshot metadata marker.
$markerDir = "C:\ProgramData\Crucible"
$markerPath = Join-Path -Path $markerDir -ChildPath "snapshot-prepared.json"
Invoke-Step "write snapshot marker" {
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
    $marker | ConvertTo-Json -Compress | Set-Content -LiteralPath $markerPath -Encoding utf8
}

$quiesced = $failures.Count -eq 0
[ordered]@{
    snapshotName = $SnapshotName
    quiesced = $quiesced
    markerPath = $markerPath
    failures = @($failures)
} | ConvertTo-Json -Compress

if (-not $quiesced) {
    exit 1
}

