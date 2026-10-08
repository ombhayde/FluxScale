$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$temporaryDirectory = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$testRoot = Join-Path $temporaryDirectory ('fluxscale-token-test-' + [guid]::NewGuid().ToString('N'))
$previousEnvironment = @{}
foreach ($name in @('FLUXSCALE_READ_TOKEN', 'FLUXSCALE_INGEST_TOKEN', 'FLUXSCALE_MANAGED_TOKEN')) {
    $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    [Environment]::SetEnvironmentVariable($name, $null, 'Process')
}
try {
    New-Item -ItemType Directory -Path $testRoot | Out-Null
    & (Join-Path $project 'scripts/local_tokens.ps1') -ProjectPath $testRoot
    $original = $env:FLUXSCALE_READ_TOKEN
    if ($original.Length -lt 32 -or $original -eq $env:FLUXSCALE_INGEST_TOKEN -or $original -eq $env:FLUXSCALE_MANAGED_TOKEN) { throw 'Provisioning did not create distinct credentials.' }
    $encrypted = Get-Content (Join-Path $testRoot '.fluxscale/tokens.clixml') -Raw
    if ($encrypted.Contains($original)) { throw 'Credential was saved in plaintext.' }
    $env:FLUXSCALE_READ_TOKEN = $null
    & (Join-Path $project 'scripts/local_tokens.ps1') -ProjectPath $testRoot
    if ($env:FLUXSCALE_READ_TOKEN -ne $original) { throw 'Saved credential did not survive reload.' }
    & (Join-Path $project 'scripts/local_tokens.ps1') -ProjectPath $testRoot -Rotate
    if ($env:FLUXSCALE_READ_TOKEN -eq $original) { throw 'Rotation did not replace the credential.' }
    Write-Host 'PASS: Credential provisioning, encrypted storage, reload and rotation.'
} finally {
    foreach ($entry in $previousEnvironment.GetEnumerator()) { [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process') }
    $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
    if (-not $resolvedTestRoot.StartsWith($temporaryDirectory, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $resolvedTestRoot) -notlike 'fluxscale-token-test-*') { throw 'Unsafe token test cleanup path.' }
    if (Test-Path -LiteralPath $resolvedTestRoot) { Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force }
}
