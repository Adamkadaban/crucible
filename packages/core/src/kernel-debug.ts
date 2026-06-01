/**
 * PowerShell script builders for kernel debugging BCD operations.
 */

/** Build a PowerShell one-liner that queries BCD kernel debug settings. */
export function buildKdStatusCommand(): string {
  return `$ErrorActionPreference='Stop'; $dbg=bcdedit /dbgsettings 2>&1 | Out-String; $enabled=(bcdedit /enum '{current}' 2>&1 | Select-String 'debug\\s+Yes' -Quiet) -eq $true; [ordered]@{enabled=$enabled; raw=$dbg.Trim()} | ConvertTo-Json -Compress`;
}

/** Build a PowerShell one-liner that enables or disables kernel debugging. */
export function buildKdToggleCommand(enable: boolean): string {
  const flag = enable ? "ON" : "OFF";
  return `$ErrorActionPreference='Stop'; bcdedit /debug ${flag} | Out-Null; $enabled=(bcdedit /enum '{current}' 2>&1 | Select-String 'debug\\s+Yes' -Quiet) -eq $true; [ordered]@{enabled=$enabled; applied=$true} | ConvertTo-Json -Compress`;
}
