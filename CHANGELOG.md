# Changelog

## Console refresh - 2026-10-09

- Added a mineral-green console theme, clearer spacing and custom capacity symbols; removed the icon-library dependency.
- Improved compact-screen metric readability and navigation accessibility labels.
- Kept public documentation focused on integration, deployment, operations and measured verification.
- Made Linux quota-test fixture transfer independent of temporary-directory permissions and waited for PostgreSQL TCP readiness.

## 0.5.0-rc.1 - 2026-10-08

- Managed Express containers now receive unique SDK identities, service names,
  controller endpoints and explicitly selected environment variables. Token
  values stay out of Docker command arguments. Optional CPU/memory quotas apply.
- Added the supported Windows/Docker Desktop local install, encrypted token
  provisioning, managed demo and a dashboard served alongside the controller API.
- Secure API deployments use same-origin browser access. Legacy security-disabled
  configuration retains its previous CORS behavior.
- Readiness waits for persistence initialization and Docker checks. Persistence
  failures retry unchanged checkpoints; empty-fleet supervision checks Docker.
- Prometheus samples are grouped by family; stopped traffic is omitted and fresh
  instance demand is reaggregated. **Exporter migration:** `fluxscale_services_total`
  becomes `fluxscale_services`, `fluxscale_service_backends_total` becomes
  `fluxscale_service_backends`, and `fluxscale_service_p95_latency_ms` becomes
  `fluxscale_service_p95_latency_seconds` with values divided by 1000.
- SDK retries preserve original windows for HTTP 429/5xx. Permanent rejections
  discard the window. Proxy request/response bodies are bounded and upstream
  requests time out after 30 seconds; redirects are returned to clients.
- SDK process CPU/RSS now use Docker cgroup-v2 CPU quotas and OS memory constraints
  when available, with parallelism/host fallbacks. Fractional CPU limits work;
  actual 0.5/2-CPU and 256 MiB tests are included in acceptance. Existing containers
  need recreation to adopt the updated SDK; historical percentages retain their
  original normalization.
- Rate-limit storage is capped at 4096 active credential/class windows.
- Dashboard preserves the light design, respects reduced motion, keeps unknown
  capacity unknown and uses actual recorded traffic history. Historical source
  backups are excluded from the TypeScript build.
- Added locked build/acceptance commands, real managed workload cycles across a
  persisted restart, Prometheus parser checks and headless Edge interaction tests.
- Added an isolated offline checkpoint restore and same-version artifact rollback
  rehearsal, including corrupt-primary recovery and refusal of unusable state paths.
- Added private Docker network execution for a containerized controller, a complete
  Compose/controller image, an SDK consumer integration guide and tarball checks.
  Network mode leaves application replica ports unpublished; the host profile
  retains loopback port publishing. Container restart/adoption is exercised live.
- Frontend lint is part of the build. Service selection is derived from current
  services; authentication failures are handled through query-cache events. The
  console page now has FluxScale metadata. Added MIT licensing, clean release
  packaging, checksums and a CI workflow.

- Added a connected account/project hub, single-use enrollment and an outbound
  agent with versioned, host-bounded policy acknowledgement. Users open the original
  React console with their own project data and session, without controller tokens.
- Added a reproducible two-user, 100,000-request recording with actual Docker
  scaling and exportable measured traffic/replica/latency analysis.
- Proxy transport failures allow one GET/HEAD failover within the shared request
  deadline; mutation requests are never replayed.
- Scale-in uses current and retained recent measured traffic and pressure, so
  brief forecast dips cannot erase observed demand.
- SDK workload labels feed the original console's Workloads view. The benchmark
  includes shared PostgreSQL reads, POST writes, five-table joins and bounded CPU
  work, with offered-rate targets separated from achieved throughput and unsent demand.

This is a local release candidate. It does not establish production throughput,
arbitrary application onboarding, multi-host orchestration or Internet deployment.
