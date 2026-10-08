# Verification and supported limits

FluxScale 0.5.0-rc.1 is a self-hosted release candidate. The checks below were
executed on Windows with Docker Desktop Linux containers. They establish the
supported local behavior; public-cloud deployment requires separate acceptance.

## Executed checks

| Check | Result |
| --- | --- |
| Rust formatting, locked build and tests | 103 passed; durable policies, workload aggregation, bounded read failover and scale-in stabilization |
| Node SDK build and tests | 7 passed; retries, permanent rejection, quota accounting and workload classification |
| React production build, lint and tests | Passed; 2 chart/history tests |
| Account and load-generator tests | 4 passed; ownership, CSRF, enrollment, revocation, session invalidation and exact counting |
| Original console in Microsoft Edge | Passed; keyboard authentication, empty/stale data, operations, lock/unlock, rotated credentials and 390px width |
| Account dashboard in Microsoft Edge | Passed; signup, projects, enrollment, policies, mobile width, logout and revoked sessions |
| Installed SDK tarball | Passed in a fresh Express consumer |
| Container resource accounting | Passed at 0.5 and 2 CPU quotas with a 256 MiB limit; touched memory and CPU measured against actual cgroup limits |
| Actual PostgreSQL workload | Passed; reads, atomic writes and five-table joins; committed writes survive removal of an app replica |
| Docker deployment | Passed; private DNS, unpublished replica ports, durable restart adoption, policy pause/resume and two scale-out/scale-in cycles |
| Control-plane protection | Passed; roles, request IDs, rate limits, bounded audit, Prometheus parsing and readiness |
| Active request lifecycle | Passed; drain completion, timeout cancellation and restart adoption |
| Persistence and recovery | Passed; offline checkpoint restore, corrupt-primary quarantine, backup recovery and unusable-state-path refusal |
| Recorder | Passed; actual Chromium navigation, concurrent capture and fully decoded MP4 |
| Clean source archive | Passed; contract checks, account tests, locked installation and React build |

The original console now uses custom SVG symbols rather than an icon package.
Account ownership and controller credentials retain their server-side boundaries.
Linux quota verification copies its fixture into the non-root container instead
of relying on host temporary-directory permissions. PostgreSQL readiness waits for
the final TCP listener before loading benchmark fixtures.

## Reproduce

Use Node 24.18+ (24.x), Rust and Docker with Linux containers. The Windows path
uses PowerShell and a Visual Studio Rust linker environment when needed:

```powershell
.\scripts\verify.ps1
node --test connected/test/*.mjs
node scripts/verify_connected_browser.mjs
node scripts/verify_mixed_workloads.mjs
node scripts/verify_deployment.mjs
```

Build the deployment/application images before the Docker verifiers, as described
in [integration](INTEGRATION.md). Browser checks use installed Microsoft Edge.
The GitHub workflow supplies locked builds and Linux container checks.

The controlled 100,000-request benchmark and full measurements are in
[BENCHMARK.md](BENCHMARK.md). It separates actual traffic, offered targets,
unsent demand and measured latency; it does not establish 100,000 successful RPS.

## Deployment acceptance

- Exercise the actual application on a clean Linux VM with configured HTTPS,
  private administrative endpoints, quotas and host-specific capacity limits.
- Run representative sustained load, database connection budgeting, host
  exhaustion and recovery checks. A local benchmark is not a production soak.
- Validate backup/restore and cross-version upgrade/rollback. Current recovery
  evidence uses the same executable version.
- Keep each application controller's credential and Docker execution boundary
  private. The Docker socket grants powerful host access.
- Complete application-specific security and accessibility review. Browser checks
  cover representative flows and width, not every assistive technology.

Application containers scale within one Docker host. Database replicas, cloud VM
provisioning, Kubernetes, HA, streaming and WebSockets are outside this release.
Node CPU/RSS accounting excludes other container processes and page cache.
GET/HEAD transport failures have one bounded proxy failover attempt; mutation
requests are never replayed. Stable, trusted SDK identities are assumed; arbitrary
identity churn requires additional control-plane limits.
