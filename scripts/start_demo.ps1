param([string]$ProjectPath = '.')
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath $ProjectPath).Path
& (Join-Path $project 'scripts/local_tokens.ps1') -ProjectPath $project
$ready = Invoke-RestMethod 'http://127.0.0.1:8080/api/v1/observability/ready' -TimeoutSec 5
if ($ready.probe -ne 'ok') { throw 'Controller is not ready.' }
$existing = Invoke-RestMethod 'http://127.0.0.1:8080/api/v1/backends/sdk-demo-api' -Headers @{ Authorization = "Bearer $env:FLUXSCALE_READ_TOKEN" } -TimeoutSec 5
if (@($existing.backends).Count -gt 0) { Write-Host 'The managed demo already exists; its live telemetry will maintain the target.'; return }
$body = @{ service = 'sdk-demo-api'; timestamp = [DateTime]::UtcNow.ToString('o'); requests_per_second = 0; active_requests = 0; p95_latency_ms = 0; error_rate = 0; cpu_percent = 0; memory_percent = 0; current_replicas = 1 } | ConvertTo-Json -Compress
Invoke-RestMethod 'http://127.0.0.1:8080/api/v1/metrics' -Method Post -ContentType 'application/json' `
    -Headers @{ Authorization = "Bearer $env:FLUXSCALE_MANAGED_TOKEN"; 'X-FluxScale-Execution-Mode' = 'managed' } -Body $body -TimeoutSec 5 | Out-Null
Write-Host 'Demo provisioning requested. Proxy: http://127.0.0.1:8081/sdk-demo-api/api/fast'
