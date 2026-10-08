# Local operating guide

Use `fluxscale.local.toml` through `scripts/start.ps1` after `scripts/build.ps1`.
This path supports Windows, Node 24 and Docker Desktop Linux containers. The
controller owns containers whose labels and names match `fluxscale-local`.
Use a distinct prefix, state location and port block for a second controller;
controllers must never share a state file or ownership prefix.

## Credentials and access

`scripts/local_tokens.ps1` generates or loads three distinct credentials. Its
CLIXML file encrypts passwords using Windows protection for the current account.
Copying that file to another account/machine does not provision working secrets.
Read, ingest and managed roles remain separate. The browser only uses read.
Docker administrators can inspect container environment values; the managed
credential must be treated as privileged.

To rotate, stop the controller with Ctrl+C, stop the exact owned application
containers, then run `local_tokens.ps1 -Rotate`, restart the controller and run
`start_demo.ps1`. Rotation replaces all three credentials. Running containers
retain their original environment, so they must be recreated. Existing history
can remain; do not delete state to rotate tokens. Load the new read token in the
dashboard after it returns to its login screen.

The controller API listens on all interfaces to support Docker Desktop's host
gateway. Keep access confined to the local/trusted network with a host firewall.
The proxy is loopback-only. Remote deployment requires a deliberately configured
TLS/reverse-proxy boundary and is not included in this profile. Secure mode denies
cross-origin browser API access; use the console served at the controller origin.

## Stop, restart and recover

Ctrl+C requests a final checkpoint before exit. Stopping the controller leaves
owned application containers running. Restart restores history and rediscovers
owned containers, including their proxy routes. Controller downtime interrupts
proxy requests; this is a single-controller product.

If Docker is unavailable, readiness returns 503 after the dependency check
records the failure. Supervision retries and readiness recovers on a subsequent
successful check. If an application is unhealthy, supervision attempts to restore
the target. Inspect `/health` supervision fields and authenticated `/api/v1/audit`.
For a failed image/start, check the image, selected environment variables and
container logs; do not globally prune Docker or kill other Node processes.

Persistence failures produce degraded readiness and authenticated error details.
Free disk space/fix the configured directory; the next checkpoint retries even
when content has not changed. Startup refuses to accept requests unless it can
write an initial checkpoint. An old successful checkpoint alone is not a failure:
unchanged content deliberately skips writes. The checkpoint period is five
seconds; a successful ingest is not a synchronous durable transaction.

## Backup, restore and upgrade

Stop the controller before copying the state file and its `.bak` companion.
By default they are `data/fluxscale-state.json` and `data/fluxscale-state.json.bak`.
Keep an offline copy of configuration and the previous controller/console/image
artifacts. For another data location, set `FLUXSCALE_STATE_PATH` before startup.

Restore the saved primary/backup pair to the configured state path while stopped,
then start the controller and inspect `/api/v1/persistence` restore source and
sample counts, plus readiness via its advertised capability path. Corrupt primary
recovery preserves evidence and can recover from the last good backup. State
schema remains version 1; unsupported schemas fail validation rather than being
silently interpreted. Restored decisions may cause later managed reconciliation,
so restore to the same intended ownership prefix and workload configuration.

For this update, checkpoint first, retain the previous artifacts, build from the
lockfiles, and run `scripts/verify.ps1` with isolated test state. Upgrade the
controller and built console together. For rollback, stop, restore the previous
artifacts/configuration and pre-upgrade checkpoint, then restart. Automated
installation checks and state backup recovery are tested. Run
`node scripts/verify_recovery.mjs` for an isolated offline checkpoint restore,
saved-artifact switch, corrupt-primary recovery and restart of the repaired state.
The verifier also checks that an unusable state path prevents API startup. It uses
two frozen copies of the current executable, so this is a same-version operator
rehearsal. Cross-version upgrade/rollback against a deployed application still
requires the actual previous artifacts and workload.

## Container cleanup

List containers with both the `fluxscale.managed=true` and
`fluxscale.service=sdk-demo-api` labels. Inspect the returned names and confirm
each begins `fluxscale-local-`. Stop the controller before removing only those
exact names with `docker rm -f <name>`; doing so interrupts application requests.
Leave unrelated containers alone. The next demo bootstrap recreates the minimum.
The verifier removes only containers created under its unique test prefix.

## Monitoring

Readiness is public and reveals only a generic ok/degraded result. It requires a
successful checkpoint and checks enabled supervision/dependency errors. It does
not prove application SLOs, host capacity or uninterrupted availability. Docker
supervision must stay enabled in the managed profile for continuous dependency
checks. When Docker is disabled, an absent Docker check does not prevent readiness.

Example Prometheus job, replacing the path with a locally protected file containing
the read token (do not commit that file):

```yaml
scrape_configs:
  - job_name: fluxscale
    scrape_interval: 15s
    metrics_path: /api/v1/observability/metrics
    static_configs:
      - targets: [127.0.0.1:8080]
    authorization:
      type: Bearer
      credentials_file: /run/secrets/fluxscale-read-token
```

This target assumes Prometheus runs on the controller host. A Dockerized scraper
needs the appropriate host gateway and a read-only secret mount. Scrapes use the
read rate class (default 1200/minute); readiness uses the health class. A 15-second
scrape adds four read requests per minute to the dashboard's credential budget.

Services are the only dynamic metric label; instance IDs, request IDs, raw paths
and credentials are absent. Service cardinality is not an unbounded-scale claim:
this profile assumes stable service/instance identities and trusted SDK clients.
Unknown capacity has an explicit known/phase gauge and no invented zero limit.
Expired RPS/active/latency/error samples are omitted; decisions and reported replica
counts remain explicitly historical. P95 gauges are seconds and represent the
maximum instance P95. Audit-buffer metrics are gauges, not lifetime request
counters. Metric renames are listed in `CHANGELOG.md`.

## Supported limits

Buffered HTTP request and response bodies must each fit `proxy.max_body_bytes`
(default 1 MiB). Oversized requests return 413; oversized upstream responses return
502. Upstream requests have a 30-second timeout. Streaming/WebSockets and redirect
rebasing are not supported. The rate limiter admits at most 4096 active
credential/class keys and fails closed for new keys while full. The audit deque
and metric/decision histories are bounded. Service/instance/managed-target maps
are not designed for arbitrary tenant or identity churn; this remains a trusted
local workload profile, not a public ingest service.

The demo has a one-CPU quota and 256 MiB memory limit. SDK CPU is process CPU time
divided by elapsed time and the smaller of affinity parallelism or cgroup-v2
`cpu.max` quota/period. Fractional quotas remain fractional. RSS is divided by the
smaller of host memory or Node's positive OS memory constraint. See the
[kernel quota interface](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html)
and [Node constraint API](https://nodejs.org/api/process.html#processconstrainedmemory).
These are process measurements: other container processes, memory cache and
kernel allocations are excluded. Unsupported/missing CPU quota files fall back
to available parallelism; unknown memory constraints fall back to host memory.
The supported CPU quota discovery path is the Docker cgroup-v2 namespace root;
cgroup v1 and arbitrary nested host hierarchies are not discovered.

Run `node scripts/verify_sdk_resources.mjs` after rebuilding the demo image to
check actual 0.5/2-CPU quotas and 256 MiB memory accounting. Rebuilding an image
does not update existing containers. The controller adopts those containers on
restart; use the scoped cleanup procedure above while stopped and bootstrap the
demo again to adopt the new SDK. No automatic image rollout is implemented.
Retained older samples use the previous host normalization. Preserve the state,
but allow the bounded history to refresh before comparing capacity estimates
across the SDK change; do not mix old/new SDK versions for calibration.

Latency/error-driven scaling works in the tested loop; true maximum throughput,
host exhaustion and production capacity calibration still need measurements for
the actual application and hardware.
