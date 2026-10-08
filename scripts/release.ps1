param([string]$ProjectPath = '.')
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath $ProjectPath).Path
Push-Location $project
try {
    & (Join-Path $project 'scripts/verify.ps1') -ProjectPath $project
    & node scripts/verify_contract.mjs
    if ($LASTEXITCODE -ne 0) { throw 'API contract reference check failed.' }
    & cargo build --release --locked -j 2
    if ($LASTEXITCODE -ne 0) { throw 'Optimized controller build failed.' }
    New-Item -ItemType Directory -Path (Join-Path $project 'artifacts') -Force | Out-Null
    Push-Location (Join-Path $project 'sdk/node')
    try {
        & npm pack --pack-destination ../../artifacts
        if ($LASTEXITCODE -ne 0) { throw 'SDK packaging failed.' }
    } finally { Pop-Location }
    & node scripts/verify_sdk_package.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Consumer SDK installation failed.' }
    & (Join-Path $project 'scripts/build_deployment.ps1') -ProjectPath $project
    & (Join-Path $project 'scripts/build_deployment.ps1') -ProjectPath $project -Connected
    & node scripts/verify_deployment.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Container deployment verification failed.' }
    & (Join-Path $project 'scripts/package_release.ps1') -ProjectPath $project
} finally { Pop-Location }
