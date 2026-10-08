param(
    [Parameter(Mandatory = $false)]
    [string]$ProjectPath = "."
)

$ErrorActionPreference = "Stop"
$project = (Resolve-Path -LiteralPath $ProjectPath).Path
$controlUrl = "http://127.0.0.1:18150"
$runId = [guid]::NewGuid().ToString("N").Substring(0, 12)
$service = "operations-$runId"
$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) "fluxscale-phase7i-$runId"
$configPath = Join-Path $temporaryRoot "fluxscale-phase7i.toml"
$statePath = Join-Path $temporaryRoot "runtime-state.json"
$readToken = "read-" + [guid]::NewGuid().ToString("N")
$ingestToken = "ingest-" + [guid]::NewGuid().ToString("N")
$managedToken = "managed-" + [guid]::NewGuid().ToString("N")
$invalidToken = "invalid-" + [guid]::NewGuid().ToString("N")
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
        [Parameter(Mandatory = $true)][string]$Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

function Get-HeaderValue {
    param(
        [Parameter(Mandatory = $true)]$Response,
        [Parameter(Mandatory = $true)][string]$Name
    )

    try {
        return @($Response.Headers.GetValues($Name))[0]
    } catch {
        try {
            return @($Response.Content.Headers.GetValues($Name))[0]
        } catch {
            return $null
        }
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

        $response = $client.SendAsync($request).GetAwaiter().GetResult()
        try {
            $content = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
            return [PSCustomObject]@{
                Status = [int]$response.StatusCode
                Body = $content
                Json = if ($content) { $content | ConvertFrom-Json } else { $null }
                RequestId = Get-HeaderValue -Response $response -Name "X-Request-Id"
                RateLimit = Get-HeaderValue -Response $response -Name "X-RateLimit-Limit"
                RateRemaining = Get-HeaderValue -Response $response -Name "X-RateLimit-Remaining"
                RetryAfter = Get-HeaderValue -Response $response -Name "Retry-After"
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
    Write-Host "FluxScale Phase 7I operational protection verification"
    Write-Host "Project: $project"
    Write-Host "Service: $service"
    Write-Host "Controller: $controlUrl"
    Write-Host ""

    foreach ($required in @(
        (Join-Path $project "Cargo.toml"),
        (Join-Path $project "src\api.rs"),
        (Join-Path $project "src\operations.rs"),
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
bind = "127.0.0.1:18150"

[proxy]
bind = "127.0.0.1:18151"
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
health_requests_per_minute = 100
read_requests_per_minute = 3
ingest_requests_per_minute = 2
audit_requests_per_minute = 10
"@
    [IO.File]::WriteAllText(
        $configPath,
        $configuration,
        [Text.UTF8Encoding]::new($false)
    )

    Write-Host "Building the Phase 7I Rust controller..."
    Push-Location $project
    try {
        # Windows PowerShell treats successful Cargo progress on stderr as errors when redirected.
        $ErrorActionPreference = 'Continue'
        & cargo build --locked -j 1
        $buildExit = $LASTEXITCODE
        $ErrorActionPreference = 'Stop'
        if ($buildExit -ne 0) {
            throw "cargo build failed."
        }
    } finally {
        $ErrorActionPreference = 'Stop'
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

    $health = $null
    for ($attempt = 1; $attempt -le 120; $attempt++) {
        if ($controller.HasExited) {
            throw "Controller exited before becoming ready."
        }

        try {
            $response = Invoke-JsonRequest -Method GET -Path "/health"
            if ($response.Status -eq 200) {
                $health = $response.Json
                break
            }
        } catch {
        }

        Start-Sleep -Milliseconds 250
    }

    Assert-True ($null -ne $health) "Controller did not become ready."
    Assert-True ($health.capabilities.audit -eq $true) "Controller does not advertise operational audit support."
    Assert-True `
        ($health.operations.rate_limiting_enabled -eq $true) `
        "Rate limiting is not active."
    Assert-True `
        ($health.operations.credential_storage -eq "fingerprint_only") `
        "Credential-safe operational metadata is not active."
    Write-Host "[PASS] Operational capabilities are visible through health"

    $correlationId = "phase7i-client-$runId"
    $correlated = Invoke-JsonRequest `
        -Method GET `
        -Path "/api/v1/services" `
        -Headers @{
            Authorization = "Bearer $readToken"
            "X-Request-Id" = $correlationId
        }

    Assert-True ($correlated.Status -eq 200) "Authorized read request failed."
    Assert-True `
        ($correlated.RequestId -eq $correlationId) `
        "Client correlation ID was not echoed."
    Assert-True `
        (-not [string]::IsNullOrWhiteSpace($correlated.RateRemaining)) `
        "Rate-limit visibility headers are missing."
    Write-Host "[PASS] Client and generated request correlation is active"

    $invalidStatuses = @()
    $generatedIds = @()
    for ($attempt = 1; $attempt -le 4; $attempt++) {
        $response = Invoke-JsonRequest `
            -Method GET `
            -Path "/api/v1/services" `
            -Headers @{ Authorization = "Bearer $invalidToken" }
        $invalidStatuses += $response.Status
        $generatedIds += $response.RequestId

        if ($attempt -eq 4) {
            Assert-True ($response.Status -eq 429) "Read abuse was not rate limited."
            Assert-True `
                (-not [string]::IsNullOrWhiteSpace($response.RetryAfter)) `
                "Rate-limited response omitted Retry-After."
        }
    }

    Assert-True `
        (($invalidStatuses[0..2] | Where-Object { $_ -ne 401 }).Count -eq 0) `
        "Authentication rejection changed before the configured limit."
    Assert-True `
        (($generatedIds | Where-Object { [string]::IsNullOrWhiteSpace($_) }).Count -eq 0) `
        "A rejected request omitted its generated request ID."
    Write-Host "[PASS] Repeated unauthorized reads are bounded with HTTP 429"

    for ($sample = 1; $sample -le 3; $sample++) {
        $payload = @{
            service = $service
            instance_id = "replica-a"
            timestamp = [DateTime]::UtcNow.AddMilliseconds($sample).ToString("o")
            requests_per_second = 100 + $sample
            active_requests = 1
            p95_latency_ms = 50
            error_rate = 0
            cpu_percent = 20
            memory_percent = 30
            current_replicas = 1
        } | ConvertTo-Json -Compress

        $response = Invoke-JsonRequest `
            -Method POST `
            -Path "/api/v1/metrics" `
            -Headers @{
                Authorization = "Bearer $ingestToken"
                "X-FluxScale-Execution-Mode" = "observe_only"
            } `
            -Body $payload

        if ($sample -le 2) {
            Assert-True `
                ($response.Status -eq 202) `
                "Accepted ingest request $sample returned $($response.Status)."
        } else {
            Assert-True `
                ($response.Status -eq 429) `
                "Ingest burst was not rate limited."
        }
    }

    $snapshot = Invoke-JsonRequest `
        -Method GET `
        -Path "/api/v1/services/$service" `
        -Headers @{ Authorization = "Bearer $readToken" }
    Assert-True ($snapshot.Status -eq 200) "Service snapshot request failed."
    Assert-True `
        ([int]$snapshot.Json.samples -eq 2) `
        "Rate-limited telemetry mutated service history."
    Write-Host "[PASS] Ingest limiting prevents rejected telemetry side effects"

    $audit = Invoke-JsonRequest `
        -Method GET `
        -Path "/api/v1/audit" `
        -Headers @{ Authorization = "Bearer $readToken" }
    Assert-True ($audit.Status -eq 200) "Audit endpoint request failed."
    $events = @($audit.Json.events)
    Assert-True ($events.Count -gt 0) "Audit trail is empty."
    Assert-True ($events.Count -le 100) "Audit trail exceeded its configured bound."
    Assert-True `
        (@($events | Where-Object { $_.request_id -eq $correlationId }).Count -eq 1) `
        "Correlated request is missing from the audit trail."
    Assert-True `
        (@($events | Where-Object { $_.rate_limited -eq $true }).Count -ge 2) `
        "Rate-limit decisions are missing from the audit trail."

    foreach ($secret in @($readToken, $ingestToken, $managedToken, $invalidToken)) {
        Assert-True `
            (-not $audit.Body.Contains($secret)) `
            "A credential leaked into the audit response."
    }
    Write-Host "[PASS] Bounded audit history contains outcomes without credentials"

    Write-Host ""
    Write-Host "PASS: Phase 7I operational protection verification completed."
    Write-Host "Request IDs, audit visibility and isolated rate limits are enforced."
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
