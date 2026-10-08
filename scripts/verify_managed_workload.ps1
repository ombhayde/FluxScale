param([string]$ProjectPath = '.')
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath $ProjectPath).Path
$runId = [guid]::NewGuid().ToString('N').Substring(0, 12)
$service = "workload-$runId"
$prefix = "fluxscale-workload-$runId"
$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) "fluxscale workload $runId"
$controlUrl = 'http://127.0.0.1:18180'
$proxyUrl = "http://127.0.0.1:18181/$service"
$controller = $null
$load = $null
$passed = $false
$previousEnvironment = @{}
foreach ($name in @('CARGO_TARGET_DIR', 'FLUXSCALE_STATE_PATH', 'FLUXSCALE_READ_TOKEN', 'FLUXSCALE_INGEST_TOKEN', 'FLUXSCALE_MANAGED_TOKEN')) {
    $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

function Assert-True([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Request([string]$Path, [string]$Token = $env:FLUXSCALE_READ_TOKEN) {
    Invoke-RestMethod "$controlUrl$Path" -Headers @{ Authorization = "Bearer $Token" } -TimeoutSec 5
}
function Wait-For([scriptblock]$Check, [string]$Description) {
    for ($attempt = 0; $attempt -lt 180; $attempt++) {
        if ($controller -and $controller.HasExited) { throw 'Test controller exited unexpectedly.' }
        try { if (& $Check) { Write-Host "[PASS] $Description"; return } } catch { }
        Start-Sleep -Milliseconds 500
    }
    throw "Timed out: $Description"
}
function Docker-Names {
    $names = @(& docker ps --filter "label=fluxscale.service=$service" --filter 'label=fluxscale.managed=true' --format '{{.Names}}')
    Assert-True ($LASTEXITCODE -eq 0) 'Docker listing failed.'
    @($names | Where-Object { $_.StartsWith("$prefix-") })
}
function Topology([int]$Expected) {
    $backends = @((Request "/api/v1/backends/$service").backends)
    $names = @(Docker-Names)
    $healthy = @($backends | Where-Object { $_.healthy -and -not $_.draining })
    $registered = @($backends | ForEach-Object { $_.name } | Sort-Object)
    $running = @($names | Sort-Object)
    $healthy.Count -eq $Expected -and $names.Count -eq $Expected -and ($registered -join '|') -eq ($running -join '|')
}
function Start-Controller {
    $script:controller = Start-Process -FilePath $binaryPath -ArgumentList ('"' + $configPath + '"') -WorkingDirectory $project -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput (Join-Path $temporaryRoot 'controller.stdout.log') -RedirectStandardError (Join-Path $temporaryRoot 'controller.stderr.log')
    Wait-For { (Request '/api/v1/observability/ready').probe -eq 'ok' } 'Controller is ready'
}
function Stop-OwnedProcess($Process) {
    if ($Process -and -not $Process.HasExited) { Stop-Process -Id $Process.Id -Force; $Process.WaitForExit() }
}

try {
    foreach ($port in @(18180, 18181)) {
        Assert-True (-not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) "Test port $port is already occupied."
    }
    New-Item -ItemType Directory -Path $temporaryRoot | Out-Null
    $env:CARGO_TARGET_DIR = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { Join-Path $env:LOCALAPPDATA 'FluxScale/target' }
    $env:FLUXSCALE_STATE_PATH = Join-Path $temporaryRoot 'state.json'
    foreach ($name in @('FLUXSCALE_READ_TOKEN', 'FLUXSCALE_INGEST_TOKEN', 'FLUXSCALE_MANAGED_TOKEN')) {
        [Environment]::SetEnvironmentVariable($name, [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N'), 'Process')
    }
    $configPath = Join-Path $temporaryRoot 'controller.toml'
    $dashboardPath = (Join-Path $project 'dashboard-react/dist').Replace('\', '/')
    $configuration = @"
[server]
bind = "0.0.0.0:18180"
dashboard_path = "$dashboardPath"
[proxy]
bind = "127.0.0.1:18181"
[docker]
enabled = true
image = "fluxscale/express-demo:v1"
name_prefix = "$prefix"
host_port_base = 30000
port_block_size = 4
supervision_enabled = true
supervision_interval_seconds = 2
telemetry_endpoint = "http://host.docker.internal:18180"
environment = ["FLUXSCALE_MANAGED_TOKEN"]
cpus = 1.0
memory_mb = 256
[scaling]
min_replicas = 1
max_replicas = 3
history_limit = 120
scale_up_cooldown_seconds = 0
scale_down_cooldown_seconds = 3
[security]
enabled = true
[operations]
audit_capacity = 200
"@
    [IO.File]::WriteAllText($configPath, $configuration, [Text.UTF8Encoding]::new($false))
    Push-Location $project
    try {
        & cargo build --locked -j 1
        Assert-True ($LASTEXITCODE -eq 0) 'Controller build failed.'
        & (Join-Path $project 'scripts/build_demo_image.ps1') -ProjectPath $project
    } finally { Pop-Location }
    $binaryPath = Join-Path $env:CARGO_TARGET_DIR 'debug/fluxscale-core.exe'
    Start-Controller
    $page = Invoke-WebRequest "$controlUrl/" -UseBasicParsing -TimeoutSec 5
    Assert-True ($page.Content.Contains('<div id="root">')) 'Built dashboard is not served by the controller.'
    try { Request '/api/v1/services' 'invalid' | Out-Null; throw 'Invalid read token was accepted.' } catch {
        Assert-True ([int]$_.Exception.Response.StatusCode -eq 401) 'Unauthenticated API access was not rejected.'
    }
    Write-Host '[PASS] Production dashboard and API share an origin; API still requires authentication'

    # A single idle managed sample provisions the minimum; all subsequent pressure is SDK telemetry.
    $bootstrap = @{ service = $service; timestamp = [DateTime]::UtcNow.ToString('o'); requests_per_second = 0; active_requests = 0; p95_latency_ms = 0; error_rate = 0; cpu_percent = 0; memory_percent = 0; current_replicas = 1 } | ConvertTo-Json -Compress
    Invoke-RestMethod "$controlUrl/api/v1/metrics" -Method Post -ContentType 'application/json' -Headers @{ Authorization = "Bearer $env:FLUXSCALE_MANAGED_TOKEN"; 'X-FluxScale-Execution-Mode' = 'managed' } -Body $bootstrap | Out-Null
    Wait-For { Topology 1 } 'Cold start has one healthy managed Express container'
    $containerName = @(Docker-Names)[0]
    $limits = & docker inspect --format '{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}}' $containerName
    Assert-True ($LASTEXITCODE -eq 0 -and $limits -eq '1000000000 268435456') 'Managed workload resource limits were not applied.'
    Write-Host '[PASS] Managed workload has a one-CPU quota and a 256 MiB memory limit'
    Wait-For { @((Request "/api/v1/services/$service/instances").instances | Where-Object { $_.fresh }).Count -eq 1 } 'Managed container sends unique SDK telemetry'

    for ($cycle = 1; $cycle -le 2; $cycle++) {
        $loadOutput = Join-Path $temporaryRoot "load-$cycle.json"
        $load = Start-Process -FilePath (Get-Command node).Source -WindowStyle Hidden -PassThru `
            -ArgumentList @(('"' + (Join-Path $project 'scripts/load_managed.mjs') + '"'), $proxyUrl, '40', '1500') `
            -RedirectStandardOutput $loadOutput -RedirectStandardError (Join-Path $temporaryRoot "load-$cycle.stderr.log")
        $load.Handle | Out-Null
        Wait-For { Topology 3 } "Cycle ${cycle}: real proxy traffic scales to three healthy replicas"
        Wait-For { @((Request "/api/v1/services/$service/instances").instances | Where-Object { $_.fresh }).Count -eq 3 } "Cycle ${cycle}: all three managed replicas send fresh SDK telemetry"
        $snapshot = Request "/api/v1/services/$service"
        Assert-True ($snapshot.latest.requests_per_second -gt 0 -and $snapshot.latest.current_replicas -eq 3) 'Real fleet aggregate is missing.'
        [IO.File]::WriteAllText((Join-Path $temporaryRoot "snapshot-$cycle.json"), ($snapshot | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
        $load.WaitForExit()
        $result = Get-Content -LiteralPath $loadOutput -Raw | ConvertFrom-Json
        Assert-True ($load.ExitCode -eq 0 -and $result.failed -eq 0 -and $result.completed -gt 0 -and $result.instances.Count -eq 3) 'Proxy load did not complete without errors across all three replicas.'
        Write-Host "[PASS] Cycle ${cycle}: $($result.completed) requests, zero failures, three identities, client P95=$([math]::Round($result.p95_ms)) ms"
        Wait-For { (Request "/api/v1/services/$service").latest_decision.desired_replicas -eq 1 -and (Topology 1) } "Cycle ${cycle}: idle workload scales back to one replica"
        if ($cycle -eq 1) {
            Start-Sleep -Seconds 6
            Assert-True (Test-Path -LiteralPath $env:FLUXSCALE_STATE_PATH) 'No checkpoint was produced.'
            Stop-OwnedProcess $controller
            $controller = $null
            Start-Controller
            Assert-True ((Request '/api/v1/persistence').restore_source -eq 'primary') 'Persisted state was not restored.'
            Wait-For { Topology 1 } 'Controller restart adopts the existing managed container'
        }
    }
    $passed = $true
    Write-Host 'PASS: Cold and persisted managed SDK workload loops completed.'
} finally {
    Stop-OwnedProcess $load
    Stop-OwnedProcess $controller
    try {
        foreach ($name in @(Docker-Names)) { & docker rm -f $name *> $null }
    } finally {
        foreach ($entry in $previousEnvironment.GetEnumerator()) { [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process') }
    }
    Write-Host "Verification artifacts: $temporaryRoot (passed=$passed)"
}
