param([string]$ProjectPath = '.', [switch]$Rotate)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Local encrypted token provisioning requires Windows.' }
$project = (Resolve-Path -LiteralPath $ProjectPath).Path
$tokenPath = Join-Path $project '.fluxscale/tokens.clixml'
$names = @('FLUXSCALE_READ_TOKEN', 'FLUXSCALE_INGEST_TOKEN', 'FLUXSCALE_MANAGED_TOKEN')
if ($Rotate -or -not (Test-Path -LiteralPath $tokenPath)) {
    $credentials = @{}
    foreach ($name in $names) {
        $value = if (-not $Rotate -and [Environment]::GetEnvironmentVariable($name, 'Process')) {
            [Environment]::GetEnvironmentVariable($name, 'Process')
        } else {
            $bytes = New-Object byte[] 32
            $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
            try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
            [Convert]::ToBase64String($bytes)
        }
        $credentials[$name] = [Management.Automation.PSCredential]::new($name, (ConvertTo-SecureString $value -AsPlainText -Force))
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $tokenPath) -Force | Out-Null
    $credentials | Export-Clixml -LiteralPath $tokenPath
}
$credentials = Import-Clixml -LiteralPath $tokenPath
foreach ($name in $names) {
    if (-not $credentials.ContainsKey($name)) { throw 'Local token file is incomplete.' }
    $value = $credentials[$name].GetNetworkCredential().Password
    if ($value.Length -lt 32 -or $value.Length -gt 512) { throw 'Local token file contains an invalid credential.' }
    [Environment]::SetEnvironmentVariable($name, $value, 'Process')
}
Write-Host 'Local credentials loaded (encrypted for this Windows account; values are not printed).'
