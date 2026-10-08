param(
    [Parameter(Mandatory = $false)]
    [string]$ProjectPath = "."
)

$ErrorActionPreference = "Stop"
$project = (Resolve-Path -LiteralPath $ProjectPath).Path
$controlUrl = "http://127.0.0.1:18090"
$proxyUrl = "http://127.0.0.1:18091"
$runId = [guid]::NewGuid().ToString("N").Substring(0, 12)
$service = "managed-lifecycle-$runId"
$namePrefix = "fluxscale-phase7d-$runId"
$temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) "fluxscale-phase7d-$runId"
$configPath = Join-Path $temporaryRoot "fluxscale-phase7d.toml"
$statePath = Join-Path $temporaryRoot "runtime-state.json"
$dockerSourcePath = Join-Path $project "docker\demo-service"
$dockerContextPath = Join-Path $temporaryRoot "docker-context"
$dockerfileSourcePath = Join-Path $dockerSourcePath "Dockerfile"
$serverSourcePath = Join-Path $dockerSourcePath "server.py"
$dockerfileContextPath = Join-Path $dockerContextPath "Dockerfile"
$serverContextPath = Join-Path $dockerContextPath "server.py"
$readToken = "read-" + [guid]::NewGuid().ToString("N")
$ingestToken = "ingest-" + [guid]::NewGuid().ToString("N")
$managedToken = "managed-" + [guid]::NewGuid().ToString("N")
$controller = $null
$client = $null
$passed = $false
$controllerNumber = 0
$metricClock = [DateTime]::UtcNow
$logFiles = [System.Collections.Generic.List[string]]::new()

$environmentNames = @(
    "CARGO_TARGET_DIR",
    "FLUXSCALE_STATE_PATH",
    "FLUXSCALE_READ_TOKEN",
    "FLUXSCALE_INGEST_TOKEN",
    "FLUXSCALE_MANAGED_TOKEN"
)

$previousEnvironment = @{}

function Assert-Condition {
    param(
        [Parameter(Mandatory = $true)][bool]$Condition,
        [Parameter(Mandatory = $true)][string]$Message
    )

    if (-not $Condition) {
        throw $Message
    }
}

function Assert-Equal {
    param(
        [Parameter(Mandatory = $true)]$Actual,
        [Parameter(Mandatory = $true)]$Expected,
        [Parameter(Mandatory = $true)][string]$Message
    )

    if ($Actual -ne $Expected) {
        throw "$Message Expected '$Expected', received '$Actual'."
    }
}

function Invoke-JsonRequest {
    param(
        [Parameter(Mandatory = $true)][string]$Method,
        [Parameter(Mandatory = $true)][string]$Url,
        [hashtable]$Headers = @{},
        [string]$Body
    )

    $request = [System.Net.Http.HttpRequestMessage]::new(
        [System.Net.Http.HttpMethod]::new($Method),
        $Url
    )

    try {
        $request.Headers.TryAddWithoutValidation("Accept", "application/json") | Out-Null

        foreach ($entry in $Headers.GetEnumerator()) {
            $added = $request.Headers.TryAddWithoutValidation(
                [string]$entry.Key,
                [string]$entry.Value
            )

            if (-not $added) {
                throw "Could not add HTTP header $($entry.Key)."
            }
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
                Json = if ($content) {
                    try {
                        $content | ConvertFrom-Json
                    } catch {
                        $null
                    }
                } else {
                    $null
                }
            }
        } finally {
            $response.Dispose()
        }
    } finally {
        $request.Dispose()
    }
}

function Stop-TestProcess {
    param([System.Diagnostics.Process]$Process)

    if ($Process -and -not $Process.HasExited) {
        Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
        $Process.WaitForExit()
    }
}

function Start-TestController {
    $script:controllerNumber += 1
    $stdout = Join-Path $temporaryRoot "controller-$($script:controllerNumber).stdout.log"
    $stderr = Join-Path $temporaryRoot "controller-$($script:controllerNumber).stderr.log"
    $logFiles.Add($stdout)
    $logFiles.Add($stderr)

    $binaryName = if ($IsLinux -or $IsMacOS) {
        "fluxscale-core"
    } else {
        "fluxscale-core.exe"
    }

    $binaryPath = Join-Path $env:CARGO_TARGET_DIR "debug\$binaryName"

    if (-not (Test-Path -LiteralPath $binaryPath)) {
        throw "Built controller binary is missing: $binaryPath"
    }

    return Start-Process `
        -FilePath $binaryPath `
        -ArgumentList @($configPath) `
        -WorkingDirectory $project `
        -RedirectStandardOutput $stdout `
        -RedirectStandardError $stderr `
        -WindowStyle Hidden -PassThru
}

function Wait-ForController {
    param([Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process)

    for ($attempt = 1; $attempt -le 120; $attempt++) {
        if ($Process.HasExited) {
            throw "FluxScale controller exited before becoming ready."
        }

        try {
            $response = Invoke-JsonRequest -Method GET -Url "$controlUrl/health"

            if ($response.Status -eq 200) {
                return $response.Json
            }
        } catch {
            # Listener may still be starting or topology recovery may be probing.
        }

        Start-Sleep -Milliseconds 250
    }

    throw "FluxScale controller did not become ready at $controlUrl."
}

function Get-Backends {
    $response = Invoke-JsonRequest `
        -Method GET `
        -Url "$controlUrl/api/v1/backends/$service" `
        -Headers @{ Authorization = "Bearer $readToken" }

    Assert-Equal $response.Status 200 "Backend registry request failed."
    return @($response.Json.backends)
}

function Get-DockerNames {
    $output = & docker ps `
        --filter "label=fluxscale.service=$service" `
        --filter "label=fluxscale.managed=true" `
        --format "{{.Names}}"

    if ($LASTEXITCODE -ne 0) {
        throw "Could not inspect Docker containers for $service."
    }

    return @($output | Where-Object { $_ -and $_.Trim() })
}

function Wait-ForTopology {
    param(
        [Parameter(Mandatory = $true)][int]$Expected,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $last = ""

    for ($attempt = 1; $attempt -le 240; $attempt++) {
        $backends = @(Get-Backends)
        $dockerNames = @(Get-DockerNames)
        $healthy = @($backends | Where-Object { $_.healthy -eq $true })
        $draining = @($backends | Where-Object { $_.draining -eq $true })
        $description = "$($healthy.Count) healthy / $($draining.Count) draining / " +
            "$($backends.Count) registered / $($dockerNames.Count) running"

        if ($description -ne $last) {
            Write-Host "  ${Label}: $description; expected=$Expected"
            $last = $description
        }

        $registeredNames = @($backends | ForEach-Object { $_.name } | Sort-Object)
        $runningNames = @($dockerNames | Sort-Object)
        $sameNames = ($registeredNames -join "|") -eq ($runningNames -join "|")

        if (
            $healthy.Count -eq $Expected -and
            $draining.Count -eq 0 -and
            $backends.Count -eq $Expected -and
            $dockerNames.Count -eq $Expected -and
            $sameNames
        ) {
            return $backends
        }

        Start-Sleep -Milliseconds 250
    }

    throw "$Label did not reach an exact $Expected-replica topology. Last state: $last"
}

function Wait-ForDrainState {
    param([Parameter(Mandatory = $true)][string]$Label)

    for ($attempt = 1; $attempt -le 80; $attempt++) {
        $backends = @(Get-Backends)
        $healthy = @($backends | Where-Object { $_.healthy -eq $true })
        $draining = @($backends | Where-Object { $_.draining -eq $true })
        $activeDraining = ($draining | Measure-Object -Property active_requests -Sum).Sum

        if (
            $backends.Count -eq 3 -and
            $healthy.Count -eq 1 -and
            $draining.Count -eq 2 -and
            $activeDraining -ge 2
        ) {
            Write-Host "  ${Label}: 1 accepting / 2 draining / $activeDraining active draining requests"
            return $backends
        }

        Start-Sleep -Milliseconds 100
    }

    throw "$Label did not expose the expected draining state."
}

function Send-ManagedMetric {
    param(
        [Parameter(Mandatory = $true)][double]$Rps,
        [double]$LatencyMs = 80
    )

    $backends = @(Get-Backends)
    $actual = @($backends | Where-Object { $_.healthy -eq $true }).Count
    $script:metricClock = $script:metricClock.AddSeconds(1)

    $payload = @{
        service = $service
        timestamp = $script:metricClock.ToString("o")
        requests_per_second = $Rps
        active_requests = [Math]::Max(1, [Math]::Ceiling($Rps / 10))
        p95_latency_ms = $LatencyMs
        error_rate = 0
        cpu_percent = 35
        memory_percent = 40
        current_replicas = [Math]::Max(1, $actual)
    } | ConvertTo-Json -Compress

    $response = Invoke-JsonRequest `
        -Method POST `
        -Url "$controlUrl/api/v1/metrics" `
        -Headers @{
            Authorization = "Bearer $managedToken"
            "X-FluxScale-Execution-Mode" = "managed"
        } `
        -Body $payload

    Assert-Equal $response.Status 202 "Managed metric was not accepted."
    Assert-Condition ($response.Json.accepted -eq $true) "Managed metric response was invalid."

    $decision = $response.Json.decision
    Write-Host (
        "  {0} RPS / {1} ms | {2} {3}->{4} | predicted={5}" -f
        [Math]::Round($Rps),
        [Math]::Round($LatencyMs),
        $decision.action,
        $decision.current_replicas,
        $decision.desired_replicas,
        [Math]::Round($decision.predicted_rps)
    )

    return $decision
}

function Scale-ToThree {
    Write-Host "Scaling test service to three replicas..."

    $current = @(Get-DockerNames).Count

    if ($current -eq 0) {
        Send-ManagedMetric -Rps 100 -LatencyMs 80 | Out-Null
        Wait-ForTopology -Expected 1 -Label "Baseline" | Out-Null
    }

    $current = @(Get-DockerNames).Count

    while ($current -lt 3) {
        $rps = if ($current -le 1) { 250 } else { 500 }
        $decision = Send-ManagedMetric -Rps $rps -LatencyMs 700
        $target = [int]$decision.desired_replicas
        Assert-Condition (
            $target -gt $current -and $target -le 3
        ) "Scale-out decision did not advance toward three replicas."
        Wait-ForTopology -Expected $target -Label "Scale-out" | Out-Null
        $current = @(Get-DockerNames).Count
    }
}

function Request-ScaleDown {
    param([Parameter(Mandatory = $true)][string]$Label)

    for ($sample = 1; $sample -le 12; $sample++) {
        $decision = Send-ManagedMetric -Rps 20 -LatencyMs 80

        if (
            $decision.action -eq "scale_down" -and
            [int]$decision.desired_replicas -eq 1
        ) {
            Write-Host "  $Label requested 3->1"
            return
        }

        Start-Sleep -Milliseconds 150
    }

    throw "$Label did not produce a 3->1 scale-down decision."
}

function Start-SlowRequests {
    param(
        [Parameter(Mandatory = $true)][int]$Count,
        [Parameter(Mandatory = $true)][int]$DelayMs
    )

    $records = @()

    for ($index = 1; $index -le $Count; $index++) {
        $request = [System.Net.Http.HttpRequestMessage]::new(
            [System.Net.Http.HttpMethod]::Get,
            "$proxyUrl/$service/slow?delay_ms=$DelayMs&request=$index"
        )

        $request.Headers.TryAddWithoutValidation("Accept", "application/json") | Out-Null

        $records += [PSCustomObject]@{
            Request = $request
            Task = $client.SendAsync($request)
        }
    }

    return $records
}

function Wait-ForEveryBackendActive {
    param([Parameter(Mandatory = $true)][string]$Label)

    for ($attempt = 1; $attempt -le 80; $attempt++) {
        $backends = @(Get-Backends)
        $inactive = @($backends | Where-Object { [int64]$_.active_requests -lt 1 })

        if ($backends.Count -eq 3 -and $inactive.Count -eq 0) {
            Write-Host "  ${Label}: all three backends hold an active request"
            return
        }

        Start-Sleep -Milliseconds 100
    }

    throw "$Label did not distribute one active request to every backend."
}

function Complete-SlowRequests {
    param(
        [Parameter(Mandatory = $true)][array]$Records,
        [Parameter(Mandatory = $true)][int]$ExpectedDelayMs,
        [Parameter(Mandatory = $true)][string]$Label
    )

    $instances = [System.Collections.Generic.HashSet[string]]::new()

    foreach ($record in $Records) {
        try {
            $response = $record.Task.GetAwaiter().GetResult()

            try {
                Assert-Equal ([int]$response.StatusCode) 200 "$Label request failed."
                $body = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult() |
                    ConvertFrom-Json
                Assert-Condition (
                    [int]$body.elapsed_ms -ge ($ExpectedDelayMs - 500)
                ) "$Label returned before its requested delay."
                $instances.Add([string]$body.instance_id) | Out-Null
            } finally {
                $response.Dispose()
            }
        } finally {
            $record.Request.Dispose()
        }
    }

    Assert-Equal $instances.Count 3 "$Label did not complete on all three original replicas."
    Write-Host "  ${Label}: all three long requests completed successfully"
}

function Cancel-SlowRequests {
    param([Parameter(Mandatory = $true)][array]$Records)

    $client.CancelPendingRequests()

    foreach ($record in $Records) {
        try {
            $record.Task.Wait(5000) | Out-Null
        } catch {
            # Forced controller interruption is expected to abort proxy requests.
        } finally {
            $record.Request.Dispose()
        }
    }
}

function Verify-FastRoutingDuringDrain {
    param([Parameter(Mandatory = $true)][array]$DrainState)

    $survivor = @($DrainState | Where-Object { $_.healthy -eq $true })[0].name

    for ($requestNumber = 1; $requestNumber -le 10; $requestNumber++) {
        $response = Invoke-JsonRequest `
            -Method GET `
            -Url "$proxyUrl/$service/fast?drain_probe=$requestNumber"

        Assert-Equal $response.Status 200 "Fast proxy request failed during drain."
        Assert-Equal $response.Json.instance_id $survivor "Proxy routed new traffic to a draining backend."
    }

    Write-Host "  New traffic stayed on the single accepting backend"
}

function Verify-AllRecoveredRoutes {
    $expected = @((Get-Backends) | ForEach-Object { $_.name } | Sort-Object)
    $seen = [System.Collections.Generic.HashSet[string]]::new()

    for ($requestNumber = 1; $requestNumber -le 12; $requestNumber++) {
        $response = Invoke-JsonRequest `
            -Method GET `
            -Url "$proxyUrl/$service/fast?restart_probe=$requestNumber"

        Assert-Equal $response.Status 200 "Recovered proxy route failed."
        $seen.Add([string]$response.Json.instance_id) | Out-Null
    }

    Assert-Equal $seen.Count 3 "Recovered proxy did not reach every adopted replica."
    Assert-Condition (
        (($seen | Sort-Object) -join "|") -eq ($expected -join "|")
    ) "Recovered proxy returned an unexpected instance identity."
}

try {
    Write-Host "FluxScale Phase 7D lifecycle safety verification v2"
    Write-Host "Project: $project"
    Write-Host "Service: $service"
    Write-Host ""

    foreach ($required in @(
        (Join-Path $project "Cargo.toml"),
        $dockerfileSourcePath,
        $serverSourcePath
    )) {
        if (-not (Test-Path -LiteralPath $required)) {
            throw "Required file is missing: $required"
        }
    }

    foreach ($name in $environmentNames) {
        $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
    }

    $env:CARGO_TARGET_DIR = if ($env:CARGO_TARGET_DIR) {
        $env:CARGO_TARGET_DIR
    } else {
        Join-Path $env:LOCALAPPDATA "FluxScale\target"
    }

    $env:FLUXSCALE_STATE_PATH = $statePath
    $env:FLUXSCALE_READ_TOKEN = $readToken
    $env:FLUXSCALE_INGEST_TOKEN = $ingestToken
    $env:FLUXSCALE_MANAGED_TOKEN = $managedToken

    New-Item -ItemType Directory -Path $temporaryRoot -Force | Out-Null

    $configuration = @"
[server]
bind = "127.0.0.1:18090"

[proxy]
bind = "127.0.0.1:18091"
max_body_bytes = 1048576

[docker]
enabled = true
image = "fluxscale/demo-service:phase7d"
container_port = 3000
host_port_base = 28000
port_block_size = 25
name_prefix = "$namePrefix"
health_timeout_seconds = 15
drain_timeout_seconds = 5

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
"@

    [IO.File]::WriteAllText(
        $configPath,
        $configuration,
        [Text.UTF8Encoding]::new($false)
    )

    Write-Host "Checking Docker and staging a reparse-safe Phase 7D build context..."
    & docker info *> $null

    if ($LASTEXITCODE -ne 0) {
        throw "Docker Desktop is not ready."
    }

    $dockerfileContent = [IO.File]::ReadAllText($dockerfileSourcePath)
    $serverContent = [IO.File]::ReadAllText($serverSourcePath)

    if ($dockerfileContent -notmatch '(?im)^\s*FROM\s+\S+') {
        throw "Phase 7D Dockerfile is readable but does not contain a valid FROM instruction: $dockerfileSourcePath"
    }

    if (
        $serverContent -notmatch 'ThreadingHTTPServer' -or
        $serverContent -notmatch '/slow'
    ) {
        throw "Phase 7D demo server is incomplete; expected ThreadingHTTPServer and /slow support: $serverSourcePath"
    }

    New-Item -ItemType Directory -Path $dockerContextPath -Force | Out-Null

    [IO.File]::WriteAllBytes(
        $dockerfileContextPath,
        [IO.File]::ReadAllBytes($dockerfileSourcePath)
    )

    [IO.File]::WriteAllBytes(
        $serverContextPath,
        [IO.File]::ReadAllBytes($serverSourcePath)
    )

    Write-Host "Building the Phase 7D demo image from the staged context..."
    & docker build `
        --file $dockerfileContextPath `
        --tag "fluxscale/demo-service:phase7d" `
        $dockerContextPath

    if ($LASTEXITCODE -ne 0) {
        throw "Phase 7D demo image build failed."
    }

    Write-Host "Building the Rust controller..."
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
    $client.Timeout = [TimeSpan]::FromSeconds(40)

    $controller = Start-TestController
    $health = Wait-ForController -Process $controller

    Assert-Equal $health.in_flight_request_draining $true "Controller does not support request draining."
    Assert-Equal $health.in_flight_request_draining $true "In-flight draining is unavailable."
    Assert-Equal $health.restart_topology_recovery $true "Restart recovery is unavailable."
    Assert-Equal $health.reconciliation_coalescing $true "Reconciliation coalescing is unavailable."
    Assert-Equal $health.drain_timeout_policy "cancel_scale_in" "Unsafe drain timeout policy."
    Write-Host "[PASS] Phase 7D controller safety capabilities are active"

    Scale-ToThree

    Write-Host "Testing successful long-request draining..."
    $slow = @(Start-SlowRequests -Count 3 -DelayMs 3000)
    Wait-ForEveryBackendActive -Label "Graceful drain"
    Request-ScaleDown -Label "Graceful drain"
    $drainState = @(Wait-ForDrainState -Label "Graceful drain")
    Assert-Equal (@(Get-DockerNames).Count) 3 "A draining container stopped before its request completed."
    Verify-FastRoutingDuringDrain -DrainState $drainState
    Complete-SlowRequests -Records $slow -ExpectedDelayMs 3000 -Label "Graceful drain"
    Wait-ForTopology -Expected 1 -Label "Graceful drain completion" | Out-Null
    Write-Host "[PASS] In-flight requests completed before scale-in"

    Scale-ToThree

    Write-Host "Testing drain-timeout fail-open behavior..."
    $slow = @(Start-SlowRequests -Count 3 -DelayMs 8000)
    Wait-ForEveryBackendActive -Label "Timeout safety"
    Request-ScaleDown -Label "Timeout safety"
    $drainState = @(Wait-ForDrainState -Label "Timeout safety")
    Verify-FastRoutingDuringDrain -DrainState $drainState
    Start-Sleep -Seconds 6
    $afterTimeout = @(Wait-ForTopology -Expected 3 -Label "Timeout cancellation")
    Assert-Equal (@(Get-DockerNames).Count) 3 "Drain timeout destroyed an active container."
    Complete-SlowRequests -Records $slow -ExpectedDelayMs 8000 -Label "Timeout safety"
    Write-Host "[PASS] Drain timeout cancelled scale-in without killing requests"

    Request-ScaleDown -Label "Post-timeout recovery"
    Wait-ForTopology -Expected 1 -Label "Post-timeout recovery" | Out-Null
    Scale-ToThree

    Write-Host "Testing forced interruption and restart topology recovery..."
    $interrupted = @(Start-SlowRequests -Count 3 -DelayMs 8000)
    Wait-ForEveryBackendActive -Label "Interrupted drain"
    Request-ScaleDown -Label "Interrupted drain"
    Wait-ForDrainState -Label "Interrupted drain" | Out-Null
    Assert-Equal (@(Get-DockerNames).Count) 3 "Interrupted drain lost a container before controller stop."

    Stop-TestProcess -Process $controller
    $controller = $null
    Cancel-SlowRequests -Records $interrupted
    Assert-Equal (@(Get-DockerNames).Count) 3 "Controller interruption removed managed containers."

    $controller = Start-TestController
    $health = Wait-ForController -Process $controller
    Assert-Equal $health.restart_topology_recovery $true "Restarted controller does not support topology recovery."
    Wait-ForTopology -Expected 3 -Label "Restart adoption" | Out-Null
    Verify-AllRecoveredRoutes
    Write-Host "[PASS] Restart rediscovered containers and restored all proxy routes"

    Request-ScaleDown -Label "Final recovery"
    Wait-ForTopology -Expected 1 -Label "Final recovery" | Out-Null

    Write-Host ""
    Write-Host "PASS: Phase 7D lifecycle safety verification completed."
    Write-Host "Verified: graceful drain, timeout cancellation, forced-restart adoption and 3->1 recovery."
    Write-Host "Owned test containers will be removed after verification."
    Write-Host "Service: $service"
    $passed = $true
} finally {
    Stop-TestProcess -Process $controller

    foreach ($ownedName in @(Get-DockerNames)) {
        if ($ownedName.StartsWith("$namePrefix-")) { & docker rm -f $ownedName *> $null }
    }
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
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force -ErrorAction SilentlyContinue
    } else {
        Write-Host "Verification artifacts preserved at: $temporaryRoot"

        foreach ($logPath in $logFiles) {
            if (Test-Path -LiteralPath $logPath) {
                Write-Host "Log: $logPath"
                Get-Content -LiteralPath $logPath -ErrorAction SilentlyContinue
            }
        }
    }
}
