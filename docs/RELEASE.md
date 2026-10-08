# FluxScale 0.5.0-rc.1

A self-hosted autoscaling application developers can integrate with a Dockerized
Node/Express API. A Rust controller and HTTP proxy use live per-instance telemetry
to forecast demand, return explainable scaling decisions, manage replica health
and safely drain replicas during scale-in. A React console shows traffic, capacity
learning, instances, decisions and audit events.

## Included

- Source archive with lockfiles, tests, Docker/Compose deployment and integration guide.
- Installable `fluxscale-node-0.1.0.tgz` SDK with types and Express middleware.
- Optimized Windows x64 controller executable and SHA-256 checksums.
- MIT license, real console screenshot, verification report and GitHub CI workflow.

Build the Linux deployment image from source; images and the SDK have not been
published to a registry. The optimized executable alone does not include the
console/configuration: use the source project's built console and local profile,
or the complete Compose image. The source archive preserves no user credentials,
runtime checkpoints, dependency directories or historical source snapshots.

## Verified scope

One controller, one Docker host and one trusted stateless/interchangeable HTTP
application image. Developers can configure their image, middleware, health route,
environment variables, resource quotas and replica bounds. The Docker network
profile connects the controller and replicas over private DNS without publishing
application replica ports. Use [the integration guide](INTEGRATION.md).

The release verification covers Rust, SDK, frontend lint/build/tests, role isolation,
timestamp/deduplication/freshness, quota accounting, real proxy-driven scale-out and
scale-in, request draining, persisted restart/adoption, backup recovery and browser
authentication/empty/stale/mobile flows. An installed SDK tarball was tested in a
fresh Express consumer. See [measured evidence](VERIFICATION.md).

## Scope boundaries

This is a usable release candidate for a trusted self-hosted deployment, not a
claim of complete production certification. HTTPS/domain provisioning, cross-version
rollback, a production soak and capacity/host-exhaustion calibration for the user's
actual workload need deployment-specific validation. No HA, multi-host provisioning,
Kubernetes, streaming or WebSockets are included. The connected extension adds
account/project isolation; it requires a dedicated local controller per application,
and has not been verified on a public cloud VM. Node CPU/RSS
measurements exclude other container processes and cache.

The controller's Docker socket grants powerful host access. Keep its API private
and put customer traffic behind your configured HTTPS ingress. Existing images
need an explicit maintenance-window replacement; automatic rolling image upgrades
are outside this release. GitHub CI is supplied but has not run remotely yet.

## Sharing

Upload the extracted source archive contents to your GitHub repository; attach
the source ZIP, SDK tarball, Windows executable and `SHA256SUMS.txt` to a release.
Use the original React console recording and measured results described in
[the demo guide](DEMO.md), alongside [the announcement draft](LINKEDIN.md).
The repository is [ombhayde/FluxScale](https://github.com/ombhayde/FluxScale).
Registry publication and LinkedIn posting are separate steps.
