param([string]$ProjectPath = '.', [switch]$SkipDocker)
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath $ProjectPath).Path
if (-not $env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR = Join-Path $env:LOCALAPPDATA 'FluxScale/target' }
Push-Location $project
try {
    & cargo fmt --check
    if ($LASTEXITCODE -ne 0) { throw 'Rust formatting failed.' }
    & cargo test --locked -j 1
    if ($LASTEXITCODE -ne 0) { throw 'Rust tests failed.' }
    & cargo build --locked -j 1
    if ($LASTEXITCODE -ne 0) { throw 'Controller build failed.' }
    & (Join-Path $project 'scripts/test_local_tokens.ps1')
    & node --test connected/test/*.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Connected account and enrollment checks failed.' }
    foreach ($package in @('sdk/node', 'dashboard-react')) {
        Push-Location (Join-Path $project $package)
        try {
            & npm ci --no-audit --no-fund
            if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed: $package" }
            & npm run build
            if ($LASTEXITCODE -ne 0) { throw "Build failed: $package" }
            if ($package -eq 'dashboard-react') {
                & npm run lint
                if ($LASTEXITCODE -ne 0) { throw 'Dashboard lint failed.' }
            }
            & npm test
            if ($LASTEXITCODE -ne 0) { throw "Tests failed: $package" }
        } finally { Pop-Location }
    }
    if (-not $SkipDocker) { & (Join-Path $project 'scripts/build_demo_image.ps1') -ProjectPath $project }
    Write-Host 'PASS: Locked local builds and tests completed.'
} finally { Pop-Location }
