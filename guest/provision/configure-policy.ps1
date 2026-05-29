param(
  [ValidateSet("isolated-analysis")]
  [string]$Mode = "isolated-analysis",
  [bool]$DisableDefender = $true,
  [bool]$DisableCodeIntegrity = $true,
  [bool]$RequireTestSigningDisabled = $true,
  [string]$Hostname,
  [string]$ProfileUsername,
  [string]$Locale = "en-US",
  [ValidatePattern("^\d{3,5}x\d{3,5}$")]
  [string]$ScreenSize = "1920x1080",
  [bool]$DisableSleep = $true,
  [bool]$ShowFileExtensions = $true,
  [bool]$ShowHiddenFiles = $true,
  [bool]$ShowExplorerRibbon = $true,
  [bool]$ClearRecentExplorerHistory = $true,
  [bool]$CommonAnalysisLabCamouflage = $false
)

$ErrorActionPreference = "Stop"

function Add-AppliedSetting {
  param([string]$Name)
  $script:AppliedSettings.Add($Name) | Out-Null
}

function Set-DwordValue {
  param(
    [string]$Path,
    [string]$Name,
    [int]$Value
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    New-Item -Path $Path -Force | Out-Null
  }

  New-ItemProperty -Path $Path -Name $Name -PropertyType DWord -Value $Value -Force | Out-Null
}

function Get-TestSigningEnabled {
  $output = (& bcdedit.exe /enum 2>$null) -join "`n"
  return $output -match "(?im)^\s*testsigning\s+Yes\s*$"
}

function Get-CodeIntegrityBootOptions {
  $output = (& bcdedit.exe /enum 2>$null) -join "`n"
  $options = New-Object System.Collections.Generic.List[string]

  if ($output -match "(?im)^\s*nointegritychecks\s+Yes\s*$") {
    $options.Add("nointegritychecks") | Out-Null
  }

  if ($output -match "(?im)^\s*testsigning\s+Yes\s*$") {
    $options.Add("testsigning") | Out-Null
  }

  return @($options)
}

function Get-DwordValue {
  param(
    [string]$Path,
    [string]$Name
  )

  try {
    $Item = Get-ItemProperty -Path $Path -Name $Name -ErrorAction Stop
    return [int]($Item.$Name)
  } catch {
    return $null
  }
}

function Get-DefenderPreferenceValue {
  param(
    [object]$Preferences,
    [string]$Name
  )

  if (-not $Preferences) {
    return $false
  }

  return [bool]($Preferences.$Name)
}

$AppliedSettings = New-Object System.Collections.Generic.List[string]
$Warnings = New-Object System.Collections.Generic.List[string]

if ($Mode -ne "isolated-analysis") {
  throw "Analysis VM policy may only be applied in isolated-analysis mode."
}

if ($DisableDefender) {
  Set-DwordValue -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows Defender" -Name "DisableAntiSpyware" -Value 1
  Set-DwordValue -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows Defender\Real-Time Protection" -Name "DisableRealtimeMonitoring" -Value 1
  Set-DwordValue -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows Defender\Real-Time Protection" -Name "DisableBehaviorMonitoring" -Value 1
  Set-DwordValue -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows Defender\Real-Time Protection" -Name "DisableIOAVProtection" -Value 1
  Set-DwordValue -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows Defender\Spynet" -Name "SpynetReporting" -Value 0
  Set-DwordValue -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows Defender\Spynet" -Name "SubmitSamplesConsent" -Value 2
  if (Get-Command -Name Set-MpPreference -ErrorAction SilentlyContinue) {
    # Skip when WinDefend service is stopped/disabled — Set-MpPreference
    # hangs trying to reach the AM engine if the service isn't running.
    # We disable that service in offline-hive during WinPE (see
    # buildWinPeInstallScript), so on a freshly-provisioned VM the
    # cmdlet would hang for 10+ min before the qga-exec deadline fires.
    $defenderService = Get-Service -Name WinDefend -ErrorAction SilentlyContinue
    if ($null -ne $defenderService -and $defenderService.Status -eq "Running") {
      Set-MpPreference -DisableRealtimeMonitoring $true -DisableBehaviorMonitoring $true -DisableIOAVProtection $true -SubmitSamplesConsent NeverSend 2>$null
    } else {
      $Warnings.Add("WinDefend service is not running; Set-MpPreference skipped (registry policy already applied)") | Out-Null
    }
  } else {
    $Warnings.Add("Set-MpPreference is unavailable; Defender preference changes are limited to registry policy") | Out-Null
  }
  Add-AppliedSetting "defender-disabled"
}

if ($DisableCodeIntegrity) {
  Set-DwordValue -Path "HKLM:\SYSTEM\CurrentControlSet\Control\DeviceGuard" -Name "EnableVirtualizationBasedSecurity" -Value 0
  Set-DwordValue -Path "HKLM:\SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\HypervisorEnforcedCodeIntegrity" -Name "Enabled" -Value 0
  & bcdedit.exe /set nointegritychecks on | Out-Null
  Add-AppliedSetting "code-integrity-policy-disabled"
}

if ($RequireTestSigningDisabled) {
  & bcdedit.exe /set testsigning off | Out-Null
  Add-AppliedSetting "test-signing-disabled"
}

if ($Hostname) {
  $CurrentName = $env:COMPUTERNAME
  if ($CurrentName -ne $Hostname) {
    Rename-Computer -NewName $Hostname -Force
    $Warnings.Add("hostname change requires a reboot before it is visible everywhere") | Out-Null
  }
  Add-AppliedSetting "hostname"
}

Set-WinSystemLocale -SystemLocale $Locale
Set-Culture -CultureInfo $Locale
Add-AppliedSetting "locale"

if ($DisableSleep) {
  & powercfg.exe /change standby-timeout-ac 0 | Out-Null
  & powercfg.exe /change standby-timeout-dc 0 | Out-Null
  & powercfg.exe /hibernate off | Out-Null
  Add-AppliedSetting "sleep-disabled"
}

if ($ShowFileExtensions) {
  Set-DwordValue -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced" -Name "HideFileExt" -Value 0
  Add-AppliedSetting "show-file-extensions"
}

if ($ShowHiddenFiles) {
  Set-DwordValue -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced" -Name "Hidden" -Value 1
  Set-DwordValue -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced" -Name "ShowSuperHidden" -Value 1
  Add-AppliedSetting "show-hidden-files"
}

if ($ShowExplorerRibbon) {
  Set-DwordValue -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Ribbon" -Name "MinimizedStateTabletModeOff" -Value 0
  Add-AppliedSetting "show-explorer-ribbon"
}

if ($ClearRecentExplorerHistory) {
  Remove-Item -Path "$env:APPDATA\Microsoft\Windows\Recent\*" -Force -Recurse -ErrorAction SilentlyContinue
  Add-AppliedSetting "clear-recent-explorer-history"
}

if ($CommonAnalysisLabCamouflage) {
  Set-DwordValue -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced" -Name "LaunchTo" -Value 1
  Set-DwordValue -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced" -Name "SeparateProcess" -Value 1
  New-Item -Path "$env:USERPROFILE\Desktop\Documents" -ItemType Directory -Force | Out-Null
  New-Item -Path "$env:USERPROFILE\Desktop\Screenshots" -ItemType Directory -Force | Out-Null
  Add-AppliedSetting "common-analysis-lab-camouflage"
}

if (Get-Command -Name Get-MpPreference -ErrorAction SilentlyContinue) {
  # Same WinDefend-stopped hang concern as Set-MpPreference above.
  $defenderForGet = Get-Service -Name WinDefend -ErrorAction SilentlyContinue
  if ($null -ne $defenderForGet -and $defenderForGet.Status -eq "Running") {
    $DefenderPreferences = Get-MpPreference -ErrorAction SilentlyContinue
  } else {
    $DefenderPreferences = $null
    $Warnings.Add("WinDefend service is not running; Get-MpPreference skipped (registry policy audit only)") | Out-Null
  }
} else {
  $DefenderPreferences = $null
  $Warnings.Add("Get-MpPreference is unavailable; Defender preference audit is limited to registry policy") | Out-Null
}

$DefenderService = Get-Service -Name WinDefend -ErrorAction SilentlyContinue
$CodeIntegrityBootOptions = Get-CodeIntegrityBootOptions
$TestSigningEnabled = Get-TestSigningEnabled
$DefenderPolicyDisabled = (Get-DwordValue -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows Defender" -Name "DisableAntiSpyware") -eq 1
$DefenderRealtimePolicyDisabled = (Get-DwordValue -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows Defender\Real-Time Protection" -Name "DisableRealtimeMonitoring") -eq 1
$DefenderRealtimePreferenceDisabled = Get-DefenderPreferenceValue -Preferences $DefenderPreferences -Name "DisableRealtimeMonitoring"
$CodeIntegrityPolicyValue = Get-DwordValue -Path "HKLM:\SYSTEM\CurrentControlSet\Control\DeviceGuard" -Name "EnableVirtualizationBasedSecurity"
$HvciPolicyValue = Get-DwordValue -Path "HKLM:\SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\HypervisorEnforcedCodeIntegrity" -Name "Enabled"
$CodeIntegrityStateRecorded = ($null -ne $CodeIntegrityPolicyValue) -and ($null -ne $HvciPolicyValue)
$HvciDisabled = $HvciPolicyValue -eq 0
$CodeIntegrityDisabled = ($CodeIntegrityPolicyValue -eq 0) -and $HvciDisabled

if ($RequireTestSigningDisabled -and $TestSigningEnabled) {
  throw "Test signing is enabled. Isolated analysis VMs must keep test signing disabled by default."
}

if (-not $CodeIntegrityStateRecorded) {
  $Warnings.Add("Code-integrity registry policy state could not be fully observed") | Out-Null
}

$Audit = [ordered]@{
  schemaVersion = 1
  mode = $Mode
  generatedAt = (Get-Date).ToUniversalTime().ToString("o")
  defender = [ordered]@{
    disabled = [bool]$DefenderPolicyDisabled
    realTimeProtectionDisabled = [bool]($DefenderRealtimePolicyDisabled -or $DefenderRealtimePreferenceDisabled)
    serviceStatus = if ($DefenderService) { [string]$DefenderService.Status } else { "missing" }
    preferencesRecorded = [bool]($DefenderPreferences -or $DefenderRealtimePolicyDisabled)
  }
  codeIntegrity = [ordered]@{
    stateRecorded = [bool]$CodeIntegrityStateRecorded
    enforcementDisabled = [bool]$CodeIntegrityDisabled
    hypervisorEnforcedCodeIntegrityDisabled = [bool]$HvciDisabled
    bootOptions = @($CodeIntegrityBootOptions)
  }
  testSigning = [ordered]@{
    enabled = [bool]$TestSigningEnabled
    requiredDisabled = [bool]$RequireTestSigningDisabled
  }
  profile = [ordered]@{
    hostname = $Hostname
    username = $ProfileUsername
    locale = $Locale
    screenSize = $ScreenSize
    disableSleep = [bool]$DisableSleep
    showFileExtensions = [bool]$ShowFileExtensions
    showHiddenFiles = [bool]$ShowHiddenFiles
    showExplorerRibbon = [bool]$ShowExplorerRibbon
    clearRecentExplorerHistory = [bool]$ClearRecentExplorerHistory
    commonAnalysisLabCamouflage = [bool]$CommonAnalysisLabCamouflage
    appliedSettings = @($AppliedSettings)
  }
  warnings = @($Warnings)
}

$Audit | ConvertTo-Json -Depth 8
