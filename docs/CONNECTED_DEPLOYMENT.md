# Deploy the connected application

The connected application adds individual accounts, isolated projects and an
outbound host agent to the existing real Docker autoscaler. It currently supports
one Node/Express application image and controller per Linux Docker host. Multiple
users and projects are supported centrally; additional application controllers on
the same VM need independent ports, Docker ownership and agent installations.
It scales containers, not cloud VMs. AWS/GCP integration here means running on a
Linux VM in either provider; no cloud credentials are requested.

## Central dashboard

The dashboard server needs Node 24.18+ (24.x) and persistent local disk. Its SQLite
database stores accounts, sessions, projects, policies and the latest host report.
Keep that disk private and back it up. There are no npm dependencies for the hub
or agent. The React console retains its existing locked dependencies.

Build both deployment images and the example application using the shipped scripts
on Windows, or Docker on Linux:

```powershell
.\scripts\build_deployment.ps1
.\scripts\build_deployment.ps1 -Connected
.\scripts\build_demo_image.ps1
```

```sh
docker build -f deploy/Dockerfile -t fluxscale/controller:0.5.0-rc.1 .
docker build -f connected/Dockerfile -t fluxscale/connected:0.1.0 .
```

For a public dashboard, point a domain's DNS to your Linux server and allow ports
80/443 for the supplied HTTPS ingress. Start from the repository root:

```sh
export FLUXSCALE_HUB_DOMAIN=fluxscale.your-domain.example
docker compose -f connected/compose.yaml up -d --build
docker compose -f connected/compose.yaml exec hub node admin.mjs invite you@example.com
```

The administrator command intentionally displays a one-use invitation. Deliver
it securely. Open `https://fluxscale.your-domain.example/connected`, choose
"Create account", and use the invited email. Invitations expire after 24 hours.
Public anonymous registration is disabled. The hub has no Docker socket access.

For a private local preview, build the React dashboard and run from `connected`:

```sh
node admin.mjs invite you@example.com
node server.mjs
```

Open `http://127.0.0.1:8090/connected`. Loopback HTTP is allowed for development;
remote host communication requires HTTPS. Public URLs must be exact origins
(without paths or trailing slashes). Server sessions use HttpOnly cookies and
CSRF tokens, expire after 12 hours, and are invalidated on password change.

## Connect a user's deployed application

1. Create a project in the dashboard with a service ID and replica bounds. New
   dashboard projects begin with automatic scaling paused.
2. On the application VM, follow [the existing application integration guide](INTEGRATION.md)
   to install the SDK, build the user's application image, configure its health
   route/environment/quotas and deploy the local controller. Bootstrap its initial
   healthy managed replica before enrolling a paused project. Retain local control
   ports on loopback and explicitly migrate existing application traffic through
   its proxy behind the user's HTTPS ingress. Existing unrelated containers are
   not adopted automatically.
3. Load that controller's `FLUXSCALE_READ_TOKEN` and `FLUXSCALE_MANAGED_TOKEN` into
   your installation shell. Do not send these credentials to the central hub.
4. Generate a host enrollment in the dashboard. On the VM, set the following
   environment variables securely, then run the installer from the source checkout:

```sh
export FLUXSCALE_HUB_ORIGIN=https://fluxscale.your-domain.example
export FLUXSCALE_SERVICE=my-orders-api
# Load FLUXSCALE_ENROLLMENT_TOKEN through your secret manager or a silent prompt.
# The local read and managed tokens must already be loaded.
sh connected/install-agent.sh
unset FLUXSCALE_ENROLLMENT_TOKEN
```

The installer requires Linux and Docker, uses host networking to reach the
loopback controller, and stores the issued host credential under
`$HOME/.fluxscale/agent/agent.json` by default. It does not expose the Docker socket
or open an inbound agent port. Keep the checked-out source directory available
because the agent mounts it read-only. Never commit agent identity files or local
controller tokens. The Docker daemon's administrators can inspect container
environment variables, including installation credentials; protect host access.

The agent reports every five seconds. The dashboard shows policy acknowledgement
only after the local controller persists that version. If the host's configured
maximum is three, a dashboard maximum of four is rejected rather than silently
raising the host limit. Correct the policy in the dashboard. The engine's local
image, resource quotas, health checks and credential configuration remain under
the VM owner's control.

After the host connects, check health, SDK telemetry and traffic routing before
enabling automatic scaling. A paused policy prevents telemetry from bootstrapping
a missing replica, so initial managed provisioning must precede enrollment.
Observe container changes under actual application traffic.

## Disconnection, pause, revocation and upgrades

Pausing prevents new telemetry-driven scaling actions. Work already in progress
can finish; health supervision continues repairing the existing target. A network
outage leaves the local controller on its last persisted policy. Revoking a host
invalidates central reporting and policy access immediately; it does not stop
applications or pause their local controller. Pause and await acknowledgement
before revocation if local autoscaling must stop.

For an agent upgrade, preserve `agent.json`, stop/remove only the named agent
container, update its mounted source, and recreate it with the same local read
and managed credentials and identity directory. Enrollment is unnecessary for
an existing identity. Re-enrollment after revocation requires archiving the old
agent identity; never delete the local application's runtime state. A new central
installation must preserve project policy versions when reconnecting existing
controllers, which reject stale/conflicting versions.

For a hub backup, stop the hub briefly and copy the entire persistent database
directory, including SQLite sidecar files, into protected backup storage. Restore
it on private disk with the same HTTPS origin before restarting. Do not copy only
the main database file while writes are active. The container image contains no
accounts or runtime credentials. To recover a locked-out account, the operator
can run `node admin.mjs reset-password EMAIL` inside the hub container; it issues
a random password and invalidates all existing sessions.

## Verification and current production gates

Run `node --test connected/test/*.mjs` for account/tenant/CSRF/enrollment checks.
After building the controller image, `node scripts/verify_deployment.mjs` uses
real Docker application replicas and the real hub/agent protocol to test pause,
resume, host bounds, telemetry, scale-out, scale-in and persisted restart.

These checks are prerequisites, not a claim of production certification. A real
Linux/cloud VM, public HTTPS/DNS, installation from a clean checkout, a sustained
representative workload, operator backup/restore and an upgrade/rollback rehearsal
must pass before public production use. The hub is a single process with SQLite;
HA, federated login/MFA, serverless/Kubernetes execution and cloud VM provisioning
are outside this version. Images are built from source and not registry-published.
