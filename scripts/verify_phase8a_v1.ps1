param(
    [Parameter(Mandatory = $false)]
    [string]$ProjectPath = ".",
    [switch]$ParsePrometheus
)

$ErrorActionPreference = "Stop"

$project = (Resolve-Path -LiteralPath $ProjectPath).Path
$controlUrl = "http://127.0.0.1:18160"
$runId = [guid]::NewGuid().ToString("N").Substring(0, 12)
$service = "observability-$runId"
$specialServiceName = "weird\path-$runId"
$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) "fluxscale-phase8a-$runId"
$configPath = Join-Path $temporaryRoot "fluxscale-phase8a.toml"
$statePath = Join-Path $temporaryRoot "runtime-state.json"
$readToken = "read-" + [guid]::NewGuid().ToString("N")
$ingestToken = "ingest-" + [guid]::NewGuid().ToString("N")
$managedToken = "managed-" + [guid]::NewGuid().ToString("N")
$client = $null
$controller = $null
$passed = $false
$stdoutPath = Join-Path $temporaryRoot "controller.stdout.log"
$stderrPath = Join-Path $temporaryRoot "controller.stderr.log"

$environmentNames = @(
    "CARGO_TARGET_DIR",
    "FLUXSCALE_STATE_PATH",
    "FLUXSCALE_READ_TOKEN",
    "FLUXSCALE_INGEST_TOKEN",
    "FLUXSCALE_MANAGED_TOKEN"
)
$previousEnvironment = @{}

function Assert-True {
    param(
        [Parameter(Mandatory = $true)][bool]$Condition,
        [Parameter(Mandatory = $true)][string]$Category,
        [Parameter(Mandatory = $true)][string]$Detail,
        [string]$Context = ""
    )

    if (-not $Condition) {
        if ($Context) {
            throw "[$Category] $Detail | $Context"
        }
        throw "[$Category] $Detail"
    }
}

function Invoke-JsonRequest {
    param(
        [Parameter(Mandatory = $true)][string]$Method,
        [Parameter(Mandatory = $true)][string]$Path,
        [hashtable]$Headers = @{},
        [string]$Body
    )

    $request = [System.Net.Http.HttpRequestMessage]::new(
        [System.Net.Http.HttpMethod]::new($Method),
        "$controlUrl$Path"
    )

    try {
        $request.Headers.TryAddWithoutValidation("Accept", "application/json") | Out-Null
        foreach ($entry in $Headers.GetEnumerator()) {
            $request.Headers.TryAddWithoutValidation(
                [string]$entry.Key,
                [string]$entry.Value
            ) | Out-Null
        }

        if ($PSBoundParameters.ContainsKey("Body")) {
            $request.Content = [System.Net.Http.StringContent]::new(
                $Body,
                [Text.Encoding]::UTF8,
                "application/json"
            )
        }

        $response = $script:client.SendAsync($request).GetAwaiter().GetResult()
        try {
            $content = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
            $parsed = $null
            if ($content) {
                try {
                    $parsed = $content | ConvertFrom-Json
                } catch {
                    $parsed = $null
                }
            }
            return [PSCustomObject]@{
                Status = [int]$response.StatusCode
                Body = $content
                Json = $parsed
            }
        } finally {
            $response.Dispose()
        }
    } finally {
        $request.Dispose()
    }
}

function Invoke-PlainRequest {
    param(
        [Parameter(Mandatory = $true)][string]$Method,
        [Parameter(Mandatory = $true)][string]$Path,
        [hashtable]$Headers = @{}
    )

    $request = [System.Net.Http.HttpRequestMessage]::new(
        [System.Net.Http.HttpMethod]::new($Method),
        "$controlUrl$Path"
    )

    try {
        $request.Headers.TryAddWithoutValidation("Accept", "*/*") | Out-Null
        foreach ($entry in $Headers.GetEnumerator()) {
            $request.Headers.TryAddWithoutValidation(
                [string]$entry.Key,
                [string]$entry.Value
            ) | Out-Null
        }

        try {
            $response = $script:client.SendAsync($request).GetAwaiter().GetResult()
        } catch [System.Exception] {
            return [PSCustomObject]@{
                Status = 0
                Body = "transport_error: $($_.Exception.Message)"
                ContentType = ""
                Headers = @{}
            }
        }
        try {
            $content = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
            $contentType = ""
            try {
                $contentType = $response.Content.Headers.ContentType.ToString()
            } catch {
            }
            $headers = @{}
            try {
                foreach ($h in $response.Headers) {
                    $headers[$h.Key] = [string]::Join(",", $h.Value)
                }
            } catch {
            }
            return [PSCustomObject]@{
                Status = [int]$response.StatusCode
                Body = $content
                ContentType = $contentType
                Headers = $headers
            }
        } finally {
            $response.Dispose()
        }
    } finally {
        $request.Dispose()
    }
}

function Stop-TestController {
    if ($script:controller -and -not $script:controller.HasExited) {
        Stop-Process -Id $script:controller.Id -Force -ErrorAction SilentlyContinue
        $script:controller.WaitForExit()
    }
}

try {
    Write-Host "FluxScale Phase 8A observability and readiness verification"
    Write-Host "Project: $project"
    Write-Host "Service: $service"
    Write-Host "Controller: $controlUrl"
    Write-Host ""

    foreach ($required in @(
        (Join-Path $project "Cargo.toml"),
        (Join-Path $project "src\api.rs"),
        (Join-Path $project "src\observability.rs"),
        (Join-Path $project "src\config.rs")
    )) {
        if (-not (Test-Path -LiteralPath $required)) {
            throw "Required file is missing: $required"
        }
    }

    foreach ($name in $environmentNames) {
        $previousEnvironment[$name] =
            [Environment]::GetEnvironmentVariable($name, "Process")
    }

    New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null
    $env:CARGO_TARGET_DIR = if ($env:CARGO_TARGET_DIR) {
        $env:CARGO_TARGET_DIR
    } else {
        Join-Path $env:LOCALAPPDATA "FluxScale\target"
    }
    $env:FLUXSCALE_STATE_PATH = $statePath
    $env:FLUXSCALE_READ_TOKEN = $readToken
    $env:FLUXSCALE_INGEST_TOKEN = $ingestToken
    $env:FLUXSCALE_MANAGED_TOKEN = $managedToken

    $configuration = @"
[server]
bind = "127.0.0.1:18160"

[proxy]
bind = "127.0.0.1:18161"
max_body_bytes = 1048576

[ingestion]
max_past_age_seconds = 900
max_future_skew_seconds = 30
instance_stale_after_seconds = 10

[docker]
enabled = false
port_block_size = 25

[scaling]
min_replicas = 1
max_replicas = 3
prediction_horizon_seconds = 10
history_limit = 120
scale_up_cooldown_seconds = 0
scale_down_cooldown_seconds = 0
scale_down_utilization = 0.45
target_p95_latency_ms = 500.0
max_error_rate = 0.05

[security]
enabled = true
public_health = true
read_token_env = "FLUXSCALE_READ_TOKEN"
ingest_token_env = "FLUXSCALE_INGEST_TOKEN"
managed_token_env = "FLUXSCALE_MANAGED_TOKEN"

[operations]
rate_limiting_enabled = true
audit_capacity = 100
health_requests_per_minute = 600
read_requests_per_minute = 1200
ingest_requests_per_minute = 1200
audit_requests_per_minute = 120
"@
    [IO.File]::WriteAllText(
        $configPath,
        $configuration,
        [Text.UTF8Encoding]::new($false)
    )

    Write-Host "Building the Phase 8A Rust controller..."
    Push-Location $project
    try {
        & cargo build -j 1
        if ($LASTEXITCODE -ne 0) {
            throw "cargo build failed."
        }
    } finally {
        Pop-Location
    }

    Add-Type -AssemblyName System.Net.Http
    $client = [System.Net.Http.HttpClient]::new()
    $client.Timeout = [TimeSpan]::FromSeconds(20)
    $binaryName = if ($IsLinux -or $IsMacOS) {
        "fluxscale-core"
    } else {
        "fluxscale-core.exe"
    }
    $binaryPath = Join-Path $env:CARGO_TARGET_DIR "debug\$binaryName"

    $controller = Start-Process `
        -FilePath $binaryPath `
        -ArgumentList @($configPath) `
        -WorkingDirectory $project `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath `
        -WindowStyle Hidden -PassThru

    $ready = $null
    for ($attempt = 1; $attempt -le 120; $attempt++) {
        if ($controller.HasExited) {
            throw "Controller exited before becoming ready."
        }

        try {
            $response = Invoke-PlainRequest -Method GET -Path "/api/v1/observability/ready"
            if ($response.Status -eq 200) {
                $ready = $response.Body
                break
            }
        } catch {
        }

        Start-Sleep -Milliseconds 250
    }

    Assert-True ($null -ne $ready) "readiness" "Controller did not become ready."
    Assert-True ($ready.Contains('"probe":"ok"')) "readiness.body" "Body did not report the ok probe."
    Write-Host "[PASS] Controller readiness probe is healthy"

    $publicReady = Invoke-PlainRequest -Method GET -Path "/api/v1/observability/ready"
    Assert-True ($publicReady.Status -eq 200) "readiness.public" "Readiness endpoint is not reachable without credentials."
    Write-Host "[PASS] /api/v1/observability/ready is publicly accessible"

    $health = Invoke-JsonRequest -Method GET -Path "/health"
    Assert-True ($health.Status -eq 200) "health.status" "Health endpoint failed."
    Assert-True ($health.Json.release -eq "8A") "health.release" "Health payload does not advertise the new release."
    Assert-True ($health.Json.capabilities.audit -eq $true) "health.capabilities.audit" "Audit capability missing."
    Assert-True ($health.Json.capabilities.observability.metrics -eq "/api/v1/observability/metrics") "health.capabilities.metrics" "Observability metrics path missing."
    Assert-True ($health.Json.capabilities.observability.ready -eq "/api/v1/observability/ready") "health.capabilities.ready" "Observability readiness path missing."
    Assert-True ($health.Json.capabilities.secure_ingest -eq $true) "health.capabilities.secure_ingest" "Secure-ingest capability missing."
    Write-Host "[PASS] /health exposes release and capabilities"

    $noToken = Invoke-PlainRequest -Method GET -Path "/api/v1/observability/metrics"
    Assert-True ($noToken.Status -eq 401) "metrics.no_token" "Unauthenticated metrics request must be rejected."
    Write-Host "[PASS] /api/v1/observability/metrics rejects missing credentials"

    $ingestAs = Invoke-PlainRequest -Method GET -Path "/api/v1/observability/metrics" -Headers @{Authorization = "Bearer $ingestToken"}
    Assert-True ($ingestAs.Status -eq 403) "metrics.ingest_token" "Ingest token must not satisfy the metrics read permission."
    Write-Host "[PASS] Ingest token does not satisfy the metrics read permission"

    $readMetrics = Invoke-PlainRequest -Method GET -Path "/api/v1/observability/metrics" -Headers @{Authorization = "Bearer $readToken"}
    Assert-True ($readMetrics.Status -eq 200) "metrics.read_token.status" "Read token must be allowed on metrics."
    Assert-True ($readMetrics.ContentType.StartsWith("text/plain")) "metrics.content_type" "Metrics response is not text/plain."
    Assert-True ($readMetrics.Headers["Cache-Control"] -eq "no-store") "metrics.cache_control" "Metrics response must set Cache-Control: no-store."
    Write-Host "[PASS] /api/v1/observability/metrics accepts the read token"

    $initialBody = $readMetrics.Body
    foreach ($family in @(
        "fluxscale_build_info",
        "fluxscale_controller_uptime_seconds",
        "fluxscale_readiness",
        "fluxscale_persistence_status",
        "fluxscale_persistence_state_schema_version",
        "fluxscale_docker_enabled",
        "fluxscale_docker_supervision_status",
        "fluxscale_audit_events",
        "fluxscale_audit_capacity",
        "fluxscale_audit_rate_limited_events",
        "fluxscale_services"
    )) {
        $assertion = "# TYPE $family "
        Assert-True ($initialBody.Contains($assertion)) "metrics.family.$family" "Missing required family declaration: $family"
    }
    Assert-True ($initialBody.Contains('release="8A"')) "metrics.release_label" "Release label is not 8A."
    Assert-True ($initialBody.Contains("fluxscale_readiness{probe=`"ok`"} 1")) "metrics.readiness.ok" "Initial readiness ok gauge should be 1."
    Assert-True ($initialBody.Contains("fluxscale_services 0")) "metrics.empty_services" "Empty controller must report zero services."
    Write-Host "[PASS] Empty-controller exposition declares the expected families"

    foreach ($secret in @($readToken, $ingestToken, $managedToken)) {
        Assert-True (-not $initialBody.Contains($secret)) "metrics.no_secret_leak" "A credential appeared in the initial metrics exposition."
    }

    for ($sample = 1; $sample -le 3; $sample++) {
        $payload = @{
            service = $service
            instance_id = "replica-a"
            timestamp = [DateTime]::UtcNow.AddMilliseconds($sample * 10).ToString("o")
            requests_per_second = 100 + $sample
            active_requests = 1
            p95_latency_ms = 50
            error_rate = 0
            cpu_percent = 20
            memory_percent = 30
            current_replicas = 1
        } | ConvertTo-Json -Compress

        $ingest = Invoke-JsonRequest `
            -Method POST `
            -Path "/api/v1/metrics" `
            -Headers @{
                Authorization = "Bearer $ingestToken"
                "X-FluxScale-Execution-Mode" = "observe_only"
            } `
            -Body $payload

        Assert-True ($ingest.Status -eq 202) "ingest.$sample" "Sample $sample ingest was not accepted."
    }
    Write-Host "[PASS] Three valid ingest samples were accepted"

    $specialPayload = @{
        service = $specialServiceName
        timestamp = [DateTime]::UtcNow.AddMilliseconds(1500).ToString("o")
        requests_per_second = 10
        active_requests = 1
        p95_latency_ms = 25
        error_rate = 0
        cpu_percent = 20
        memory_percent = 30
        current_replicas = 1
    } | ConvertTo-Json -Compress

    $specialIngest = Invoke-JsonRequest `
        -Method POST `
        -Path "/api/v1/metrics" `
        -Headers @{
            Authorization = "Bearer $ingestToken"
            "X-FluxScale-Execution-Mode" = "observe_only"
        } `
        -Body $specialPayload

    Assert-True (
        $specialIngest.Status -eq 202
    ) "ingest.special" "Special-character service ingest failed." "status=$($specialIngest.Status) body=$($specialIngest.Body)"

    Start-Sleep -Milliseconds 400

    $serviceMetrics = Invoke-PlainRequest -Method GET -Path "/api/v1/observability/metrics" -Headers @{Authorization = "Bearer $readToken"}
    Assert-True ($serviceMetrics.Status -eq 200) "metrics.after_ingest" "Metrics request after ingest failed."
    $body = $serviceMetrics.Body
    if ($ParsePrometheus) {
        [IO.File]::WriteAllText((Join-Path $temporaryRoot 'populated.prom'), $body, [Text.UTF8Encoding]::new($false))
        [IO.File]::WriteAllText((Join-Path $temporaryRoot 'empty.prom'), $initialBody, [Text.UTF8Encoding]::new($false))
        & docker run --rm -v "${temporaryRoot}:/metrics:ro" --entrypoint /bin/sh prom/prometheus:v3.0.0 -c '/bin/promtool check metrics < /metrics/populated.prom'
        Assert-True ($LASTEXITCODE -eq 0) "metrics.parser" "Prometheus rejected the populated exposition."
        & docker run --rm -v "${temporaryRoot}:/metrics:ro" --entrypoint /bin/sh prom/prometheus:v3.0.0 -c '/bin/promtool check metrics < /metrics/empty.prom'
        Assert-True ($LASTEXITCODE -eq 0) "metrics.parser.empty" "Prometheus rejected the empty exposition."
        Write-Host "[PASS] Real Prometheus parser accepts populated and empty exposition"
    }

    Assert-True ($body.Contains("fluxscale_service_known{service=`"$service`"}")) "metrics.service_unknown" "Service label missing after ingest."
    Assert-True ($body.Contains("fluxscale_service_capacity_known{service=`"$service`"} 0")) "metrics.capacity_known" "Calibration must not be inferred from idle samples."
    Assert-True (-not $body.Contains("fluxscale_service_capacity_safe_rps{service=`"$service`"}")) "metrics.safe_rps_emitted" "Safe RPS must not be emitted until saturation is observed."
    Assert-True (-not $body.Contains("fluxscale_service_capacity_saturation_rps{service=`"$service`"}")) "metrics.saturation_emitted" "Saturation RPS must not be emitted until saturation is observed."
    Assert-True ($body.Contains("fluxscale_service_fresh_instances{service=`"$service`"} 1")) "metrics.fresh_instance" "Fresh instance count is wrong."
    $decisionActionPattern = "fluxscale_service_decision_action\{service=`"$service`",action=`"(scale_up|scale_down|hold)`"\} 1"
    Assert-True ($body -match $decisionActionPattern) "metrics.decision_action" "Decision action was not encoded as 1 for the service."
    Write-Host "[PASS] Per-service exposition reflects fresh samples without guessing capacity"

    $escapedService = $specialServiceName.Replace('\', '\\')
    Assert-True ($body.Contains("fluxscale_service_known{service=`"$escapedService`"}")) "metrics.special_label" "Backslash service label was not escaped correctly."
    Assert-True ($body.Contains("fluxscale_services 2")) "metrics.service_count" "services_total must reflect the two monitored services."
    Write-Host "[PASS] Label escaping and multi-service rendering are correct"

    foreach ($secret in @($readToken, $ingestToken, $managedToken)) {
        Assert-True (-not $body.Contains($secret)) "metrics.secret_leak.post" "A credential leaked into the populated metrics body."
    }
    Write-Host "[PASS] No credentials leaked into the metrics body"

    $badMetricsRequest = Invoke-PlainRequest -Method POST -Path "/api/v1/observability/metrics" -Headers @{Authorization = "Bearer $readToken"}
    Assert-True ($badMetricsRequest.Status -eq 405) "metrics.method_not_allowed" "POST on the metrics route must be rejected (only ingest accepts POST)."
    Write-Host "[PASS] POST is not a valid method for the metrics route"

    Write-Host ""
    Write-Host "PASS: Phase 8A observability and readiness verification completed."
    Write-Host "Prometheus exposition, public readiness, capability-aware auth,"
    Write-Host "label escaping and credential hygiene were enforced under isolated ports."
    $passed = $true
} finally {
    Stop-TestController
    if ($client) {
        $client.Dispose()
    }

    foreach ($name in $previousEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable(
            $name,
            $previousEnvironment[$name],
            "Process"
        )
    }

    $resolvedTemporaryRoot = [IO.Path]::GetFullPath($temporaryRoot)
    $resolvedTempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $resolvedTemporaryRoot.StartsWith($resolvedTempBase, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean verification artifacts outside the temporary directory."
    }
    if ($passed) {
        Remove-Item `
            -LiteralPath $temporaryRoot `
            -Recurse `
            -Force `
            -ErrorAction SilentlyContinue
    } else {
        Write-Host "Verification artifacts preserved at: $temporaryRoot"
        foreach ($logPath in @($stdoutPath, $stderrPath)) {
            if (Test-Path -LiteralPath $logPath) {
                Write-Host "Log: $logPath"
                Get-Content -LiteralPath $logPath -ErrorAction SilentlyContinue
            }
        }
    }
}
