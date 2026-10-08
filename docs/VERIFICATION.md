# Local release-candidate verification - 2026-10-09

Candidate: **fluxscale-core 0.5.0-rc.1**. These results were executed in this
Windows checkout, not inferred from historical handoff filenames or previous
phase labels. The supported local development acceptance command
`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify.ps1 -ProjectPath .`
completed successfully after the quota/network integration and frontend fixes,
using a separate Windows validation target to preserve the live controller.
Docker deployment and installed-tarball consumer integration also passed.
Final Rust checks also include a real readiness-handler
503/200 test and actual response-header assertions.

## Results

| Check | Result |
| --- | --- |
| Rust formatting and locked build | Passed |
| Final Rust suite | 103 passed, 0 failed, including durable project policies, bounded read failover, workload aggregation and scale-in stabilization |
| SDK locked dependency installation, typecheck and build | Passed |
| SDK retry/permanent-rejection, quota/fallback and workload tests | 7 passed |
| Real container SDK resource accounting | Passed: busy thread at 0.5 and 2 CPU quotas, RSS against 256 MiB, touched allocation increases quota-relative memory |
| Dashboard locked installation and real production build | Passed |
| Canonical frontend lint | Passed; historical source snapshots excluded, UI variant exports explicitly allowed |
| Dashboard unknown-capacity/history tests | 2 passed |
| Encrypted Windows credential provision/reload/rotation | Passed, no plaintext credential in saved CLIXML |
| Observability verifier and real Prometheus parser/linter | Passed with populated/empty exposition, multiple services and escaped labels |
| Operational protection verifier | Passed: request IDs, unauthorized-read limiting, rejected-ingest non-mutation, bounded credential-free audit |
| Real managed SDK workload | Passed: both cold and persisted loops, actual Docker/registry agreement, three unique SDK identities and 1 -> 3 -> 1 topology |
| Active request lifecycle verifier | Passed: drain completion, timeout cancellation, restart adoption and final scale-in; owned containers cleaned |
| Isolated operator recovery rehearsal | Passed: offline primary/backup pair restore, saved executable switch, removal of later test changes, corrupt-primary quarantine, backup recovery, repaired restart and refusal to start with an unusable state path |
| Real headless Microsoft Edge test | Passed: keyboard login, light theme, empty state, no endless chart spinner, unknown capacity, operations tab, stale instance, 390px viewport, lock/unlock and rotated-token recovery |
| Changed PowerShell scripts | Parsed successfully |
| Packaged SDK consumer | Passed: fresh Express project installs the .tgz, tracks real completed/error responses and excludes health requests |
| Linux controller/console Docker image and Windows optimized controller | Built from lockfiles; Linux Rust 1.90 and Node 24 console, Windows Rust 1.98 |
| Containerized deployment | Passed: private DNS, unpublished replica ports, 432 successful requests across two 1 -> 3 -> 1 cycles, persisted restart and adoption |

## Measured workload

The acceptance run used Docker Desktop Linux engine **29.7.2**, reporting **12
logical CPUs** and **8,166,977,536 bytes** of VM memory. Each managed Express
container had a verified **one-CPU quota** and **256 MiB memory limit**. The
controller/proxy used isolated test ports 18180/18181; state and credentials were
temporary. No real user runtime snapshot was deleted or reset.

Eight concurrent clients sent application requests through the FluxScale proxy
for 40 seconds per cycle. The application added a fixed 1500 ms processing delay.
Only one idle managed sample provisioned the initial minimum; subsequent demand
and pressure were the managed containers' own SDK telemetry.

| Cycle | Completed | Failed | Managed identities reached | Client P95 |
| --- | ---: | ---: | ---: | ---: |
| Cold start | 216 | 0 | 3 | 1518 ms |
| After persisted controller restart | 216 | 0 | 3 | 1519 ms |

Both cycles independently checked running container names, registered healthy
backends, three fresh SDK instances, live aggregate RPS and current replicas,
then returned to one desired/current replica after traffic stopped. The restart
restored the primary checkpoint and adopted the existing container before the
second cycle.

The retained runtime checkpoint contains 108 non-idle aggregate snapshots from
the bounded run: maximum recorded RPS **8.00**, maximum instance P95 **1503.08 ms**,
maximum recorded CPU **5.04%**, memory **1.00%**, and error ratio **0**. The last
two percentages are SDK process/host-normalized observations, not validated
container quota utilization. Raw load results/state were retained under
`%TEMP%\fluxscale workload e9fb0a06d0fb`. Later runs create different unique paths.

The fixed-delay load demonstrates a real telemetry/control/proxy/topology loop;
it does not benchmark maximum sustainable throughput or show that extra replicas
remove fixed application delay. The separate lifecycle test verifies draining
with actual outstanding requests, including the longer-than-drain-timeout case.

## Quota-accounting continuation

The rebuilt Node 22 Express image was exercised by `verify_sdk_resources.mjs` in
two isolated containers with networking disabled. Both had a 256 MiB limit. A
four-second busy single thread reported 100% CPU at a 0.5-CPU quota and 50.2% at
a 2-CPU quota. Touching a 64 MiB buffer raised RSS from about 24.3% to 52.8/52.9%
of the limit, including other runtime allocations. Reported RSS matched the
independent process RSS / configured-limit calculation within two percentage
points. Evidence: `%TEMP%\fluxscale-quota-5OyXlu\result.json`.
The final image repeat passed at 100% / 50.3% CPU, with evidence in
`%TEMP%\fluxscale-quota-N15X0L\result.json`.

The managed-workload verifier also passed again with that image: cold and
persisted cycles each completed 216 requests with zero failures and three fresh
SDK identities. Client P95 was 1528 ms / 1524 ms; both cycles returned from three
replicas to one and restart adoption passed. Evidence is retained under
`%TEMP%\fluxscale workload 746012f79fa2`. Captured fleet snapshots now show
quota-relative process RSS around 28%, rather than the earlier host-relative 1%.
Only the isolated test containers were removed; the user's live controller and
demo remained healthy and running.

These readings supersede the host-relative SDK normalization used in the earlier
load table. They measure the Node process, not complete cgroup usage or host
exhaustion. Windows/unknown CPU quota paths retain the parallelism fallback.

## Deployment and shareable package continuation

`verify_deployment.mjs` exercised the actual Compose/controller image on Docker
Desktop's Linux daemon with unique test ownership and random loopback ports.
The cold/persisted load cycles each completed 216 requests, zero failures and
three SDK identities, with client P95 1526.48 ms / 1558.66 ms. All backend URLs
used container DNS, and independent Docker inspection confirmed no published
application replica ports. Restart restored primary state and adopted the
existing replica. Evidence: `%TEMP%\fluxscale-deployment-lRSesN\result.json`.

`verify_sdk_package.mjs` installed the distributable tarball into a fresh temporary
Express consumer and verified request completion, health exclusion and a 0.5
error ratio for one successful/one failed application request. The pack manifest
contains only canonical output, declarations, source maps, README, license and
package metadata; no historical SDK files. The console screenshot is a real
browser capture using isolated test data and the reported package version.

The final full Windows acceptance log is `.fluxscale/final-verification.log`.
Optimized Windows and Linux artifacts build successfully. Source-package checks
exclude credentials/state/dependencies/history and verify required files. A
GitHub workflow is supplied; its remote execution remains untested.

The clean source ZIP was extracted into a fresh temporary directory and checked
independently: SDK and console locked dependencies installed and built; the API
route/reference check passed; all 99 Rust tests passed; the real Edge browser
interaction check passed against the extracted console. This verifies the
distributable source, not just the original working folder. Source/package hashes
are provided in `artifacts/SHA256SUMS.txt`. User credentials, runtime state,
dependency directories and historical implementation snapshots are excluded.

## Recovery and user-started demo continuation

`scripts/verify_recovery.mjs` ran successfully against frozen copies of the
0.5.0-rc.1 executable. It retains its own logs, offline checkpoint pair, preserved
corrupt primary and a result JSON with artifact SHA-256 under `%TEMP%\fluxscale recovery *`.
Both artifacts are the same version: this establishes the local operator recovery
procedure, not compatibility between different releases. Docker is disabled in
this verifier; container adoption is covered separately by the managed workload.

The user's running local profile was also checked without stopping its controller:
`load_managed.mjs` sent 40 seconds of eight-concurrent, 1500 ms-delay proxy traffic.
It completed **216 requests, zero failures, three distinct instance IDs**, with
**1519.05 ms P95**. During traffic, Docker names matched three healthy registered
backends and all three SDK identities were fresh. Afterward the registry returned
to one healthy idle backend and readiness remained `ok`. This is another bounded
1 -> 3 -> 1 demo cycle, not a production soak or capacity benchmark.

## Evidence limits and remaining production gates

- This is a locally verified self-hosted release candidate. Public deployment and
  application-specific production acceptance remain separate gates.
- No Internet/TLS deployment or multi-host/HA behavior was exercised. The local
  managed profile listens on all API interfaces for Docker Desktop's host gateway;
  keep that boundary private and controlled by the host firewall.
- Stable identities and trusted SDK clients are assumed. Rate-limit windows,
  histories, audit storage and proxy bodies are bounded; service/instance/managed
  target maps have not been hardened for arbitrary tenant/identity churn.
- Process CPU/RSS quota normalization passes on Docker cgroup v2. Full container
  pressure, host exhaustion, a true capacity benchmark and a longer production
  soak remain hardware/application-specific measurements.
- Schema-1 persistence/recovery, restart adoption and an isolated same-version
  operator rollback rehearsal pass. Cross-version upgrade/rollback against a
  deployed real application remains unexercised.
- Readiness negative/recovery behavior is tested in Rust, and healthy readiness is
  exercised live. Docker Desktop itself was not shut down to simulate an outage.
- The browser checks cover representative flows and viewport width, not a complete
  accessibility audit or visual comparison on every supported screen size.
- Streaming, WebSockets and transparent redirect rebasing remain unsupported.

Use the current README and operations guide for local startup and recovery.

## Connected account and original dashboard continuation

The connected tests cover ownership with identical service names, CSRF/origin
checks, single-use enrollment, revocation, password/session invalidation, policy
versions and project-scoped original-console routes. The load-generator check
verifies exact request counting and records failed responses without retrying.
The real Docker verifier additionally passed policy pause/resume, host-bound
rejection, agent acknowledgement and read-token rejection of policy writes.
The account browser verifier passed signup, project creation, policy updates,
logout/relogin, revoked-session cleanup and a 390px viewport.

The original React console is reused for project traffic, fleet, workloads, capacity and
operations; controller role tokens are never passed to that browser. The recorded
100,000-request run and its measured outcome are in [DEMO.md](DEMO.md).
GET/HEAD transport failures have one bounded proxy failover attempt; mutation
requests are never replayed. No public HTTPS/domain or clean cloud VM installation
has been verified, and a local recording does not establish production reliability.

The connected Linux image also passed a non-root runtime check with networking
disabled: its default server responded to health and served the React page.
The recorder regression captures ten actual Chromium navigations, concurrent
manual screenshots and a fully decoded MP4.

The final mixed-workload run completed **100,000 requests, 100,000 successes and
zero failures**, with real replicas increasing from **1 to 6 and returning to 1**.
It used CPU computation, PostgreSQL reads, atomic writes and five-table joins.
The final bulk phase achieved **340.5 successful RPS**. Offered rate targets up to
100,000 RPS are reported separately from actual sent traffic and unsent demand.
The database verifier also confirmed writes survive removal of an application
replica. The four connected test cases cover account isolation and measured load
counting. See [the measured report](DEMO.md) for the complete evidence and limits.
