import assert from 'node:assert/strict';
import { readFile, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const report = JSON.parse(await readFile(join(root,'artifacts/demo/result.json'),'utf8'));
assert.equal(report.total_attempted,100000);assert.equal(report.total_successful+report.total_failed,100000);
assert.equal(report.replica_milestones[0],1);assert.equal(report.replica_milestones.at(-1),1);assert(report.maximum_observed_replicas>=2);
const repository='https://github.com/ombhayde/FluxScale';
const rows=report.phases.map(p=>`| ${p.name} | ${p.target_rps??'—'} | ${p.attempted.toLocaleString('en-IN')} | ${p.successful.toLocaleString('en-IN')} | ${p.failed} | ${p.dropped_before_send??0} | ${p.successful_rps.toFixed(1)} | ${p.p95_ms?.toFixed(2)??'—'} |`).join('\n');
const groups={};for(const p of report.phases)for(const [name,w] of Object.entries(p.workloads)){const g=groups[name]??={attempted:0,successful:0,failed:0};for(const key of Object.keys(g))g[key]+=w[key];}
const workloadRows=Object.entries(groups).map(([name,w])=>`| ${name} | ${w.attempted.toLocaleString('en-IN')} | ${w.successful.toLocaleString('en-IN')} | ${w.failed} |`).join('\n');
const guide=`# Recorded mixed-workload autoscaling demo

This recording uses two actual accounts and two isolated local Docker deployments.
Alice sees only Store API, which receives the main workload. Bob sees only Billing
API, which receives separate baseline traffic. Server-side authorization rejects
Bob's access to Alice's project. The original FluxScale React dashboards display live SDK telemetry, actual
managed containers and scaling decisions rather than fabricated analysis.

The recorded run attempted **100,000 application requests**, with
**${report.total_successful.toLocaleString('en-IN')} successes** and **${report.total_failed} failures**.
Observed healthy replicas started at **1**, reached **${report.maximum_observed_replicas}**
and returned to **1** after traffic stopped. These are milestones; the raw timeline
records all intermediate replica changes. The configured application ceiling is
${report.host_maximum_replicas} replicas. This is total volume, not 100,000 successful RPS.

The offered-rate ladder schedules 50 to 100,000 RPS and back to 50. A bounded
128-request concurrency limit prevents an unbounded client backlog. Unsent demand
counts requests which could not start; it is not successful application traffic.
This machine did not establish 100,000 successful RPS. Actually sent client
requests across the ladder and fixed-volume phases total 100,000.

| Workload phase | Target RPS | Sent | Successful | Failed | Unsent demand | Successful RPS | Client P95 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${rows}

These are controlled benchmark conditions, not production workload measurements.
RPS includes each phase's entire measured duration and outstanding request completion.
Recording and agent reporting run alongside the workload. Latency percentiles cover successful requests only; failed requests are
reported separately. The SDK chart uses its own reporting windows, so its P95 and
RPS should not be confused with the generator's phase-wide figures. Bob's
${report.baseline_requests} baseline requests are outside Alice's 100,000-request count.

## Real workload mix

Dispatch mixes 35% database reads, 25% POST writes, 20% five-table joins and 20%
CPU operations. Failures and concurrency can change the completed mix. Reads
select product rows; writes increment shared PostgreSQL counters. Joins aggregate
customers, orders, order items, products and categories. CPU routes perform real
bounded computation: 40 ms during pressure and 5 ms in other phases.
The database contains 2,000 customers, 12,000 orders and 60,000 order items.

| Workload | Sent | Successful | Failed |
| --- | ---: | ---: | ---: |
${workloadRows}

Independent database inspection found **${report.database_writes_committed.toLocaleString('en-IN')}
committed writes**, including **${report.acknowledged_database_writes.toLocaleString('en-IN')}
acknowledged writes**. The shared database is independent of application replicas
and has no published host port. A separate test proves writes survive application
replica removal. The generator and proxy never replay mutation requests.
Database capacity, database replicas and cloud VMs are not autoscaled here.

![Original React console during real scale-out](assets/demo-scale-out.png)

![Actual application instances](assets/demo-fleet.png)

![Live read/write/join/CPU analysis](assets/demo-workloads.png)

![Measured traffic, replicas and latency](assets/demo-analysis.png)

Raw evidence: [phase results](assets/demo-result.json) and
[time-series samples](assets/demo-timeline.json).

## Architecture and integration

Customer requests pass through the local health-aware HTTP proxy to the managed
application replicas. SDK middleware sends per-instance request/resource telemetry
to the Rust controller. The controller predicts demand, evaluates pressure and
reconciles real Docker containers. New replicas must become healthy before routing;
scale-in drains active proxy requests before container removal. Scale-in considers
retained recent measured demand and pressure, so a brief forecast dip cannot
erase current demand. The timeline exposes the resulting replica behavior.

An outbound agent reports each deployment to the connected dashboard using a
project-scoped credential. Each account can access only its own projects, reports
and policies. Local controller credentials stay on the deployment host. Versioned
dashboard policies are acknowledged after local checkpointing, and the host's
configured replica limits remain authoritative.

Start with [SDK and Docker integration](INTEGRATION.md), then
[individual accounts and project dashboard setup](CONNECTED_DEPLOYMENT.md).
The supported execution path is one stateless Dockerized Node/Express application
per local controller. No cloud VM creation, Kubernetes, serverless or HA is claimed.
Repository: [ombhayde/FluxScale](${repository}).

## Reproduce and record

Build the application image and controller image, and run \`npm ci\` and
\`npm run build\` in \`dashboard-react\`. Use Node 24.18+ (24.x), Docker with Linux
containers, a Chromium browser and FFmpeg. On Windows the recorder finds installed
Edge by default. Set \`FLUXSCALE_BROWSER\` or \`FLUXSCALE_FFMPEG\` to other installed
executables. On Linux, set both executable variables explicitly before recording.
The optional recording tooling is separate from the application.

\`\`\`powershell
.\\scripts\\build_demo_image.ps1
.\\scripts\\build_deployment.ps1
docker pull postgres:18-alpine
node scripts/record_demo.mjs
\`\`\`

The recorder creates its own accounts, credentials, networks, two controllers and
application containers and a disposable shared PostgreSQL database. It restricts load to loopback targets and makes exactly
100,000 primary client requests without generator retries. The proxy may retry
a GET/HEAD transport failure once against another healthy backend; therefore
upstream attempts can exceed the client request count. Cleanup stops only the
containers it owns. Existing user services are not used for the demonstration.

Outputs under \`artifacts/demo/\`: \`fluxscale-demo.mp4\`, \`result.json\`,
\`timeline.json\`, phase results and screenshots. The MP4 captures the browser at
2 frames per second and encodes a 24 FPS video; it does not substitute simulated
dashboard data. Generate exportable PNG/PDF plots with
\`python scripts/plot_demo.py\` (requires matplotlib), then update this page and the
announcement with \`node scripts/summarize_demo.mjs\`.

## Recording sequence

1. Architecture: traffic, telemetry, real Docker control and per-user analysis.
2. Bob's account: baseline traffic in Billing API, with no Alice project visible.
3. Alice's account: request counter, workload phases and Store API analysis.
4. Actual scale-out, workload analysis and a ramp of offered-rate targets.
5. Mixed traffic burst, idle recovery and actual scale-in to one healthy replica.

Attach the MP4 directly to LinkedIn and link this repository. Keep the detailed
analysis accessible beside the integration guide; do not advertise the workload
as cloud production certification. Two earlier rehearsals recorded one and two
HTTP failures respectively and exposed burst scaling churn. The proxy now has
tested read failover, and scale-in stabilization considers actual recent demand.
The final mixed run above has its own measured outcome. Sustained production
reliability still requires representative deployment testing.
`;
await copyFile(join(root,'artifacts/demo/traffic-analysis.png'),join(root,'docs/assets/demo-analysis.png'));
await copyFile(join(root,'artifacts/demo/result.json'),join(root,'docs/assets/demo-result.json'));
await copyFile(join(root,'artifacts/demo/timeline.json'),join(root,'docs/assets/demo-timeline.json'));
await copyFile(join(root,'artifacts/demo/scale-out.png'),join(root,'docs/assets/demo-scale-out.png'));
await copyFile(join(root,'artifacts/demo/fleet.png'),join(root,'docs/assets/demo-fleet.png'));
await copyFile(join(root,'artifacts/demo/workloads.png'),join(root,'docs/assets/demo-workloads.png'));
await writeFile(join(root,'docs/DEMO.md'),guide);
await writeFile(join(root,'docs/LINKEDIN.md'),`# LinkedIn announcement draft

I built FluxScale: a self-hosted autoscaling controller with user-specific project analysis.

In this recorded local demo, I sent 1,00,000 application requests through a real
Docker deployment: ${report.total_successful.toLocaleString('en-IN')} succeeded, ${report.total_failed} failed.
The workload mixes database reads, POST writes, five-table PostgreSQL joins and CPU work.
The controller added actual containers from 1 to ${report.maximum_observed_replicas} healthy replicas, then drained and
scaled back to 1 after traffic stopped.

The recording also shows two separate user accounts. Each sees only their own
project's live traffic, workload latency, errors, containers and scaling history.

Rust controller + HTTP proxy · Node/Express telemetry SDK · React dashboard.
The repository includes Docker setup, application integration instructions,
account/project isolation checks and the measured demo analysis.

I ramped the offered load target to 100,000 RPS and measured actual throughput
and unsent demand separately. This is a controlled local workload, not a claim of
100,000 successful RPS or cloud production certification. Developers can integrate
the supported self-hosted path with their own stateless Dockerized HTTP application.

Code, measured results and integration guide: ${repository}

#Rust #Docker #NodeJS #React #OpenSource #Autoscaling

Attachment: artifacts/demo/fluxscale-demo.mp4
`);
console.log('PASS: Demo documentation and LinkedIn draft use measured results.');
