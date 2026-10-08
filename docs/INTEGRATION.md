# Deploy FluxScale with your application

This release supports one trusted application image, one controller and one Docker
host. It scales replicas of that image, not host machines. The Compose deployment
uses Linux containers and private container DNS; both administrative and proxy
ports are published on host loopback. The controller needs access to the Docker
socket, which grants host-level Docker privileges. Run it on a dedicated trusted
host; application containers must never receive the socket or the read token.

Application replicas must share an external database or other durable storage.
FluxScale scales application containers; it does not add database capacity or
cloud VMs. Size database connection pools for the maximum replica count and
keep writes out of disposable application container filesystems. The optional
[mixed-workload demo](BENCHMARK.md) verifies shared PostgreSQL writes across replica removal.

## 1. Install the SDK and prepare your image

Use Node 24 and Docker with Compose v2 to build the project. Build the SDK:

```sh
cd sdk/node
npm ci
npm run build
npm pack
```

Install the resulting `fluxscale-node-0.1.0.tgz` in your Express project. Follow the
[SDK example](../sdk/node/README.md). Your application must:

- Listen on `0.0.0.0` and the supplied `PORT` (3000 in the profile).
- Return a successful `GET /health` only when it can serve requests.
- Use `FLUXSCALE_SERVICE`, `FLUXSCALE_INSTANCE_ID`, `FLUXSCALE_ENDPOINT` and the
  managed token supplied by FluxScale; mount the SDK middleware before routes.
- Keep replicas interchangeable: store sessions/uploads/jobs in shared systems,
  and make request handling safe when more than one replica runs.
- Handle SIGTERM gracefully. FluxScale drains proxy requests before stopping
  replicas; traffic that bypasses its proxy is outside that drain accounting.

Build your image on the same Docker daemon that will run FluxScale:

```sh
docker build -t my-orders-api:1 .
```

## 2. Configure the controller

In `deploy/fluxscale.toml`, set `docker.image = "my-orders-api:1"`, the application
port, replica bounds and resource quotas. Leave `docker.network = "fluxscale-app"`
and `telemetry_endpoint = "http://controller:8080"` for this Compose deployment.
If you need DB/application configuration, add only the required environment
variable names to `docker.environment`, and add those values to the controller's
Compose environment. Docker inherits their values without putting secrets into
the controller's command arguments. Do not include identity/PORT/endpoint in that
list: FluxScale owns those values.

The proxy forwards `/<service>/<path>` to the application `/<path>`. For example,
`/orders-api/api/orders` reaches `/api/orders`. It buffers bodies up to 1 MiB by
default and has a 30-second upstream timeout. WebSockets, streaming and automatic
redirect rewriting are outside this release's HTTP contract. The full controller
API is documented in [openapi.json](../openapi.json).

## 3. Supply credentials and build

If you already run the host demo, stop its controller and exact owned replicas
using the operations guide before switching to Compose. Both profiles use ports
8080/8081; old replicas must not send telemetry to the replacement profile.

Create three distinct cryptographically random tokens. For bash on a Linux host:

```sh
export FLUXSCALE_READ_TOKEN="$(openssl rand -hex 32)"
export FLUXSCALE_INGEST_TOKEN="$(openssl rand -hex 32)"
export FLUXSCALE_MANAGED_TOKEN="$(openssl rand -hex 32)"
docker compose -f deploy/compose.yaml build
docker compose -f deploy/compose.yaml up -d
```

Persist these securely in your host's secret manager or protected environment
configuration before ending the shell; future Compose operations need the same
values. Never commit them or run `docker compose config` without `--quiet` in a
shared terminal: rendered configuration contains values. On Windows, run
`.\scripts\local_tokens.ps1` to load the account-encrypted local credentials and
`.\scripts\build_deployment.ps1` for a reparse-safe image build, then Compose up.

Check `http://127.0.0.1:8080/api/v1/observability/ready`; it must return `ok`. If the
Docker daemon/config/state volume is unavailable, inspect controller logs and
readiness rather than assuming that a running container means the controller is
ready. Open the console at port 8080 and unlock it with the read token.

## 4. Bootstrap your service

The controller will not create application containers until the service has been
registered. Submit one idle managed sample using your service name:

```sh
curl --fail-with-body http://127.0.0.1:8080/api/v1/metrics \
  -H "Authorization: Bearer $FLUXSCALE_MANAGED_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'X-FluxScale-Execution-Mode: managed' \
  --data '{"service":"orders-api","requests_per_second":0,"current_replicas":1}'
```

Wait for a healthy backend in the console, then call:

```sh
curl --fail-with-body http://127.0.0.1:8081/orders-api/api/orders
```

Subsequent SDK telemetry maintains the target. The application replicas have no
published host ports in network mode. Containers on the same network are reachable
by their names; see [Docker's Compose networking contract](https://docs.docker.com/compose/how-tos/networking/).

For remote administration, use an SSH tunnel to port 8080. For customer traffic,
put your existing HTTPS ingress in front of host loopback port 8081 (or attach it
to the private network). Route the intended service prefix and configure actual
TLS certificates/DNS there. Do not expose the administrative API directly. This
release does not provision domains or certificates and has no tested public
Internet deployment.

## 5. Operate and upgrade

Compose stores checkpoints in its named state volume. `docker compose restart`
preserves state and the controller adopts its managed replicas. `compose down`
stops the controller but leaves managed replicas; do not remove its network until
you have stopped those exact owned replicas. `down -v` destroys the Compose state
volume: use it only for intentional data removal after an offline backup.

Before changing controller, SDK, application image or quotas, stop the controller
and back up the primary/backup checkpoint pair and previous artifacts. Rebuilding
an image does not replace running replicas. For this release, stop the exact
`fluxscale-deploy-<service>-<index>` containers belonging to your service while
stopped, start the updated controller and bootstrap again. This is a maintenance
window, not a rolling deployment. Never broadly remove containers from the host.

See [operations](OPERATIONS.md) for credentials, recovery and normalization changes.
Test your own application SLOs and resource budgets before enabling managed
scaling. The included fixed-delay test proves topology/control flow; maximum
sustainable throughput and host exhaustion are application-specific measurements.

## Acceptance

After building both images, run `node scripts/verify_deployment.mjs`. It uses
unique ownership, private networks, random loopback ports and temporary state.
It verifies authenticated control access, private SDK connectivity, unpublished
replica ports, two real 1 -> 3 -> 1 workload cycles and persisted restart adoption.
It removes only its own test resources and retains evidence in the temporary
directory. Linux VM containers on Docker Desktop exercise the container path;
public ingress and a remote bare Linux server are separate deployment checks.
