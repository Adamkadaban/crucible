[CmdletBinding()]
param(
    [Parameter()]
    [string]$StandardUsername = "CrucibleUser",

    [Parameter()]
    [string]$AdminUsername = "CrucibleAdmin"
)

$ErrorActionPreference = "Stop"

function Require-SecretEnvironment {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    $value = [Environment]::GetEnvironmentVariable($Name, "Process")
    if ([string]::IsNullOrWhiteSpace($value)) {
        throw "Missing required secret environment variable: $Name"
    }

    return $value
}

function Ensure-LocalAccount {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Username,

        [Parameter(Mandatory = $true)]
        [string]$Password,

        [Parameter(Mandatory = $true)]
        [bool]$Administrator
    )

    $existing = Get-LocalUser -Name $Username -ErrorAction SilentlyContinue

    if ($null -eq $existing) {
        $securePassword = ConvertTo-SecureString $Password -AsPlainText -Force
        New-LocalUser -Name $Username -Password $securePassword -PasswordNeverExpires -UserMayNotChangePassword | Out-Null
    }
    else {
        $user = [ADSI]("WinNT://./$Username,user")
        $user.SetPassword($Password)
        $user.SetInfo()
        try {
            Set-LocalUser -Name $Username -PasswordNeverExpires:$true -UserMayChangePassword:$false -ErrorAction Stop
        } catch {
            if ($_.Exception.Message -notmatch "last Administrator") {
                throw
            }
        }
        Enable-LocalUser -Name $Username
    }

    Add-LocalGroupMember -Group "Users" -Member $Username -ErrorAction SilentlyContinue

    if ($Administrator) {
        Add-LocalGroupMember -Group "Administrators" -Member $Username -ErrorAction SilentlyContinue
    }
    else {
        Remove-LocalGroupMember -Group "Administrators" -Member $Username -ErrorAction SilentlyContinue
    }
}

function Grant-BatchLogonRight {
    param([Parameter(Mandatory = $true)][string[]]$Usernames)
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) "crucible-user-rights-$([guid]::NewGuid().ToString('n'))"
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    $export = Join-Path $tmp "export.inf"
    $import = Join-Path $tmp "import.inf"
    $db = Join-Path $tmp "secedit.sdb"
    try {
        $secedit = "$env:SystemRoot\System32\secedit.exe"
        $exportProc = Start-Process -FilePath $secedit -ArgumentList @('/export', '/cfg', $export, '/areas', 'USER_RIGHTS') -Wait -PassThru -NoNewWindow
        if ($exportProc.ExitCode -ne 0) { throw "secedit export failed (exit $($exportProc.ExitCode))" }
        $sids = @()
        foreach ($username in $Usernames) {
            $account = New-Object System.Security.Principal.NTAccount($env:COMPUTERNAME, $username)
            $sid = $account.Translate([System.Security.Principal.SecurityIdentifier]).Value
            $sids += "*$sid"
        }
        $lines = Get-Content -LiteralPath $export
        $existing = @()
        $found = $false
        $updated = foreach ($line in $lines) {
            if ($line -match '^SeBatchLogonRight\s*=\s*(.*)$') {
                $found = $true
                if (-not [string]::IsNullOrWhiteSpace($Matches[1])) {
                    $existing = $Matches[1].Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' }
                }
                "SeBatchLogonRight = " + (($existing + $sids | Select-Object -Unique) -join ',')
            } else {
                $line
            }
        }
        if (-not $found) {
            $updated += "SeBatchLogonRight = " + (($sids | Select-Object -Unique) -join ',')
        }
        $updated | Set-Content -LiteralPath $import -Encoding Unicode
        $configureProc = Start-Process -FilePath $secedit -ArgumentList @('/configure', '/db', $db, '/cfg', $import, '/areas', 'USER_RIGHTS') -Wait -PassThru -NoNewWindow
        if ($configureProc.ExitCode -ne 0) { throw "secedit configure failed (exit $($configureProc.ExitCode))" }
    } finally {
        Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

$standardPassword = Require-SecretEnvironment -Name "CRUCIBLE_STANDARD_PASSWORD"
$adminPassword = Require-SecretEnvironment -Name "CRUCIBLE_ADMIN_PASSWORD"

Ensure-LocalAccount -Username $StandardUsername -Password $standardPassword -Administrator $false
Ensure-LocalAccount -Username $AdminUsername -Password $adminPassword -Administrator $true
Grant-BatchLogonRight -Usernames @($StandardUsername, $AdminUsername)

[PSCustomObject]@{
    standardAccount = $StandardUsername
    adminAccount = $AdminUsername
    standardIsAdmin = $false
    adminIsAdmin = $true
} | ConvertTo-Json -Compress
