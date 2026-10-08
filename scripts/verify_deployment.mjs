import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { connectDeployment } from '../connected/verify-session.mjs';

const exec = promisify(execFile);
const project = fileURLToPath(new URL('../', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'fluxscale-deployment-'));
const id = randomUUID().slice(0, 8);
const ownership = `fluxscale-deployment-${id}`;
const service = 'integration-api';
const readToken = randomBytes(32).toString('hex');
const managedToken = randomBytes(32).toString('hex');
const env = { ...process.env, FLUXSCALE_READ_TOKEN: readToken,
  FLUXSCALE_INGEST_TOKEN: randomBytes(32).toString('hex'), FLUXSCALE_MANAGED_TOKEN: managedToken };
const composePath = join(root, 'compose.yaml');
const docker = args => exec('docker', args, { env, windowsHide: true, timeout: 60_000, maxBuffer: 256 * 1024 });
const compose = args => docker(['compose', '-f', composePath, '-p', ownership, ...args]);
let url;
const results = [];
let connection;

async function request(path, token = readToken, options = {}) {
  const response = await fetch(`${url}${path}`, { ...options, signal: AbortSignal.timeout(5000),
    headers: { Authorization: `Bearer ${token}`, ...options.headers } });
  assert(response.ok, `HTTP ${response.status} at ${path}`);
  return response.json();
}
async function poll(check, description) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try { if (await check()) { console.log(`[PASS] ${description}`); return; } } catch { }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out: ${description}`);
}
async function topology(count) {
  const { backends } = await request(`/api/v1/backends/${service}`);
  if (backends.length !== count || backends.some(backend => !backend.healthy || backend.draining)) return false;
  const { stdout } = await docker(['ps', '--filter', 'label=fluxscale.managed=true', '--filter', `label=fluxscale.service=${service}`, '--format', '{{.Names}}']);
  const names = stdout.trim().split('\n').filter(name => name.startsWith(`${ownership}-`)).sort();
  if (JSON.stringify(names) !== JSON.stringify(backends.map(backend => backend.name).sort())) return false;
  for (const backend of backends) {
    assert.equal(backend.url, `http://${backend.name}:3000`);
    const { stdout } = await docker(['inspect', '--format', '{{json .HostConfig.PortBindings}}', backend.name]);
    assert.equal(Object.keys(JSON.parse(stdout) ?? {}).length, 0, 'Managed application ports should remain unpublished.');
  }
  return true;
}

try {
  const listeners = [createServer(), createServer()];
  let ports;
  try {
    await Promise.all(listeners.map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
    ports = listeners.map(server => server.address().port);
  } finally { await Promise.all(listeners.map(server => new Promise(resolve => server.close(resolve)))); }
  url = `http://127.0.0.1:${ports[0]}`;
  await mkdir(join(root, 'state'));
  const config = (await readFile(join(project, 'deploy/fluxscale.toml'), 'utf8'))
    .replace('network = "fluxscale-app"', `network = "${ownership}"`)
    .replace('name_prefix = "fluxscale-deploy"', `name_prefix = "${ownership}"`);
  await writeFile(join(root, 'fluxscale.toml'), config);
  const spec = (await readFile(join(project, 'deploy/compose.yaml'), 'utf8'))
    .replace('context: ..', `context: ${JSON.stringify(project.replaceAll('\\', '/'))}`)
    .replace('127.0.0.1:8080:8080', `127.0.0.1:${ports[0]}:8080`)
    .replace('127.0.0.1:8081:8081', `127.0.0.1:${ports[1]}:8081`)
    .replace('- state:/data', `- ${JSON.stringify(join(root, 'state').replaceAll('\\', '/') + ':/data')}`)
    .replace('name: fluxscale-app', `name: ${ownership}`);
  await writeFile(composePath, spec);
  await compose(['config', '--quiet']);
  await compose(['up', '-d', '--no-build']);
  await poll(async () => (await request('/api/v1/observability/ready')).probe === 'ok', 'Containerized controller and durable volume ready');
  assert.equal((await fetch(url + '/')).status, 200);
  assert.equal((await fetch(url + '/api/v1/services')).status, 401);
  await request('/api/v1/metrics', managedToken, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-FluxScale-Execution-Mode': 'managed' },
    body: JSON.stringify({ service, timestamp: new Date().toISOString(), requests_per_second: 0, current_replicas: 1 }) });
  await poll(() => topology(1), 'Managed application reachable through private container DNS');
  connection = await connectDeployment({ root, controller: url, service, readToken, managedToken });
  const deniedPolicy = await fetch(url + `/api/v1/services/${service}/policy`, { method: 'POST', headers: { Authorization: `Bearer ${readToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ version: 2, enabled: true, min_replicas: 1, max_replicas: 3 }) });
  assert.equal(deniedPolicy.status, 403, 'Read credentials must not change autoscaling policy');
  const pausedLoad = await exec(process.execPath, [join(project, 'scripts/load_managed.mjs'), `http://127.0.0.1:${ports[1]}/${service}`, '12', '1500'], { windowsHide: true, timeout: 25000 });
  assert.equal(JSON.parse(pausedLoad.stdout).failed, 0);
  assert.equal(JSON.parse(pausedLoad.stdout).instances.length, 1);
  assert(await topology(1), 'Paused policy must retain one replica under real request pressure');
  console.log('[PASS] Connected dashboard policy pauses real scaling while traffic continues');
  const invalidVersion = await connection.policy(true, 4);
  await poll(async () => { const p = await connection.detail(); return p.host.snapshot.error && p.host.applied_version < invalidVersion; }, 'Host rejects dashboard policy beyond its local ceiling');
  const version = await connection.policy(true);
  await poll(async () => (await connection.detail()).host.applied_version === version, 'Connected dashboard enables local automatic scaling');
  for (const cycle of [1, 2]) {
    const load = exec(process.execPath, [join(project, 'scripts/load_managed.mjs'), `http://127.0.0.1:${ports[1]}/${service}`, '40', '1500'],
      { windowsHide: true, timeout: 60_000 });
    // Attach failure handling immediately while topology is polled.
    const completed = load.then(value => ({ value }), error => ({ error }));
    await poll(() => topology(3), `Deployment cycle ${cycle}: three healthy private replicas`);
    await poll(async () => (await request(`/api/v1/services/${service}/instances`)).instances.filter(instance => instance.fresh).length === 3,
      `Deployment cycle ${cycle}: three fresh SDK identities`);
    const outcome = await completed;
    if (outcome.error) throw outcome.error;
    const result = JSON.parse(outcome.value.stdout);
    assert.equal(result.failed, 0);
    assert.equal(result.instances.length, 3);
    results.push(result);
    await poll(async () => { const p = await connection.detail(); return p.host.snapshot.metrics.some(m => m.requests_per_second > 0) && p.host.snapshot.backends.length >= 1; }, 'Central dashboard reports real workload telemetry and containers');
    await poll(() => topology(1), `Deployment cycle ${cycle}: drains back to one replica`);
    if (cycle === 1) {
      await new Promise(resolve => setTimeout(resolve, 5500));
      await compose(['restart', 'controller']);
      await poll(async () => (await request('/api/v1/persistence')).restore_source === 'primary' && await topology(1),
        'Deployed controller restart restores state and adopts its application');
    }
  }
  await writeFile(join(root, 'result.json'), JSON.stringify({ image: 'fluxscale/controller:0.5.0-rc.1', results,
    private_dns: 'passed', unpublished_application_ports: 'passed', restart_adoption: 'passed', connected_accounts: 'passed', remote_policy_bounds: 'passed', pause_and_resume: 'passed', live_host_reporting: 'passed' }, null, 2));
  console.log(`PASS: Docker deployment and SDK integration. Evidence: ${root}`);
} finally {
  if (connection) await connection.close();
  const logs = await compose(['logs', '--no-color']).catch(() => null);
  if (logs) await writeFile(join(root, 'controller.log'), logs.stdout);
  await compose(['stop', 'controller']).catch(() => {});
  const owned = await docker(['ps', '-a', '--filter', 'label=fluxscale.managed=true', '--filter', `label=fluxscale.service=${service}`, '--format', '{{.Names}}']).catch(() => null);
  for (const name of owned?.stdout.split('\n').filter(name => name.startsWith(`${ownership}-`)) ?? []) {
    await docker(['rm', '-f', name]);
  }
  await compose(['down']).catch(() => {});
}
