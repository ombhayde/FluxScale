# FluxScale Node SDK

Express middleware reports per-instance throughput, active requests, maximum-window
P95, error ratio and process CPU/RSS to a FluxScale controller. The controller
returns explainable scaling decisions. Application requests continue if telemetry
delivery fails; HTTP 429/5xx windows are retried with their original identity.

This package is currently distributed as a built `.tgz` in the project artifacts;
it has not been published to the npm registry.

```sh
npm install ./fluxscale-node-0.1.0.tgz
```

```js
import express from 'express';
import { createFluxScale } from '@fluxscale/node';

const app = express();
if (!process.env.FLUXSCALE_MANAGED_TOKEN) throw new Error('Managed telemetry token is required.');
const telemetry = createFluxScale({
  service: process.env.FLUXSCALE_SERVICE ?? 'orders-api',
  endpoint: process.env.FLUXSCALE_ENDPOINT ?? 'http://controller:8080',
  instanceId: process.env.FLUXSCALE_INSTANCE_ID,
  executionMode: 'managed',
  apiToken: process.env.FLUXSCALE_MANAGED_TOKEN,
  logger: { warn: message => console.warn(message) },
});
app.use(telemetry.middleware);
app.get('/health', (_request, response) => response.json({ status: 'ok' }));
app.get('/api/orders', (_request, response) => response.json({ orders: [] }));
app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
```

Use `executionMode: 'observe_only'` with `FLUXSCALE_INGEST_TOKEN` if FluxScale must
only recommend scaling. Use distinct identities per process; managed replicas
receive their own identity, service name, endpoint and port from the controller.
Health/ready routes are excluded by default. Place middleware before application
routes and the error handler after them. Call `await telemetry.close()` during
your application's existing graceful shutdown before exiting.

Node >=20 and Express 4/5 are supported by the package; the packaged workload is
tested on Node 22. Docker cgroup-v2 CPU quotas and OS memory limits normalize
process readings. These exclude other container processes and cache. See the
root deployment guide for network, credentials, health and resource requirements.

## Workload analysis

Set `workloadLabel: request => labels[request.path]` in `createFluxScale`, where
`labels` maps stable routes to names such as `read`, `write`, `join` and `cpu`.
Use at most eight labels of 1?32 letters, digits, dots, underscores or hyphens.
Do not label with request IDs, customer identifiers, raw URLs or SQL. Unknown or
invalid labels are omitted; ordinary service telemetry continues.

Workload windows count completed operations, failures (HTTP 5xx), completed RPS
and bounded-sample P95. Idle windows retain known labels with zero completed
traffic. The dashboard combines fresh instances and displays the largest
instance P95, not a fabricated global percentile. Per-workload window counts
are not lifetime totals. Service RPS tracks request starts and can differ briefly
from completed-workload RPS when work spans reporting windows.

The Express example includes optional real PostgreSQL read/write/join endpoints.
Its database is shared across application replicas: never put production writes
in an application's disposable container filesystem. See the demo guide for
benchmark setup and the application integration guide for deployment.
