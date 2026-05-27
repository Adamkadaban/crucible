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

    $securePassword = ConvertTo-SecureString $Password -AsPlainText -Force
    $existing = Get-LocalUser -Name $Username -ErrorAction SilentlyContinue

    if ($null -eq $existing) {
        New-LocalUser -Name $Username -Password $securePassword -PasswordNeverExpires -UserMayNotChangePassword | Out-Null
    }
    else {
        Set-LocalUser -Name $Username -Password $securePassword -PasswordNeverExpires $true -UserMayChangePassword $false
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

$standardPassword = Require-SecretEnvironment -Name "CRUCIBLE_STANDARD_PASSWORD"
$adminPassword = Require-SecretEnvironment -Name "CRUCIBLE_ADMIN_PASSWORD"

Ensure-LocalAccount -Username $StandardUsername -Password $standardPassword -Administrator $false
Ensure-LocalAccount -Username $AdminUsername -Password $adminPassword -Administrator $true

[PSCustomObject]@{
    standardAccount = $StandardUsername
    adminAccount = $AdminUsername
    standardIsAdmin = $false
    adminIsAdmin = $true
} | ConvertTo-Json -Compress
