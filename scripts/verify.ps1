param([string]$ProjectPath = '.')
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath $ProjectPath).Path
& (Join-Path $project 'scripts/build.ps1') -ProjectPath $project
& node (Join-Path $project 'scripts/verify_sdk_resources.mjs')
if ($LASTEXITCODE -ne 0) { throw 'SDK quota accounting verification failed.' }
# Run sequentially: Windows cannot replace a controller executable while a verifier uses it.
foreach ($script in @('verify_phase8a_v1.ps1', 'verify_phase7i_v1.ps1', 'verify_managed_workload.ps1', 'verify_phase7d_v2.ps1')) {
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $project "scripts/$script"), '-ProjectPath', $project)
    if ($script -eq 'verify_phase8a_v1.ps1') { $arguments += '-ParsePrometheus' }
    & powershell @arguments
    if ($LASTEXITCODE -ne 0) { throw "Acceptance verifier failed: $script" }
}
& node (Join-Path $project 'scripts/verify_recovery.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Checkpoint recovery verification failed.' }
& node (Join-Path $project 'scripts/verify_dashboard.mjs')
if ($LASTEXITCODE -ne 0) { throw 'Browser interaction verification failed.' }
Write-Host 'PASS: Local release-candidate acceptance checks completed.'
