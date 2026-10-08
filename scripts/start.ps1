param([string]$ProjectPath = '.')
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath $ProjectPath).Path
& (Join-Path $project 'scripts/local_tokens.ps1') -ProjectPath $project
$targetDirectory = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $env:LOCALAPPDATA 'FluxScale/target' }
$binary = Join-Path $targetDirectory 'debug/fluxscale-core.exe'
if (-not (Test-Path -LiteralPath $binary)) { throw 'Controller binary is missing; run scripts/build.ps1 first.' }
Push-Location $project
try {
    Write-Host 'Console: http://127.0.0.1:8080. Stop with Ctrl+C; managed containers remain for restart adoption.'
    & $binary (Join-Path $project 'fluxscale.local.toml')
    if ($LASTEXITCODE -ne 0) { throw 'Controller exited with an error.' }
} finally { Pop-Location }
