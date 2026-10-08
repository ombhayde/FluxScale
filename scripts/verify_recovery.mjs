import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'fluxscale recovery '));
const statePath = join(root, 'state.json');
const configPath = join(root, 'controller.toml');
const readToken = randomBytes(32).toString('hex');
const ingestToken = randomBytes(32).toString('hex');
const managedToken = randomBytes(32).toString('hex');
let controller;
let run = 0;
let url;
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function poll(check, description, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (controller?.exitCode !== null || controller?.signalCode !== null) {
      throw new Error(`Controller exited during ${description}; inspect ${root}`);
    }
    try { if (await check()) return; } catch { }
    await delay(100);
  }
  throw new Error(`Timed out: ${description}; inspect ${root}`);
}

async function request(path, options = {}) {
  const response = await fetch(`${url}${path}`, {
    ...options, signal: AbortSignal.timeout(2000),
    headers: { Authorization: `Bearer ${readToken}`, ...options.headers },
  });
  assert(response.ok, `HTTP ${response.status} for ${path}`);
  return response.json();
}

async function start(binary, expectFailure = false) {
  const logs = [];
  controller = spawn(binary, [configPath], {
    cwd: project, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FLUXSCALE_STATE_PATH: statePath,
      FLUXSCALE_READ_TOKEN: readToken, FLUXSCALE_INGEST_TOKEN: ingestToken,
      FLUXSCALE_MANAGED_TOKEN: managedToken },
  });
  controller.stdout.on('data', chunk => logs.push(chunk));
  controller.stderr.on('data', chunk => logs.push(chunk));
  controller.on('error', error => logs.push(Buffer.from(error.message)));
  const logPath = join(root, `controller-${++run}.log`);
  controller.on('close', () => writeFile(logPath, Buffer.concat(logs)).catch(() => {}));
  if (expectFailure) {
    let timer;
    try {
      await Promise.race([
        new Promise(resolve => controller.once('close', resolve)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Controller accepted an unusable state path.')), 10_000); }),
      ]);
    } finally { clearTimeout(timer); }
    assert.notEqual(controller.exitCode, 0);
    await assert.rejects(() => fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) }));
    return;
  }
  await poll(async () => (await request('/api/v1/observability/ready')).status === 'ok', 'ready startup');
}

async function stop() {
  if (!controller) return;
  const child = controller;
  if (child.exitCode === null && child.signalCode === null) {
    const closed = new Promise(resolve => child.once('close', resolve));
    child.kill();
    await closed;
  }
  controller = undefined;
}

async function ingest(service, rps) {
  const accepted = await request('/api/v1/metrics', {
    method: 'POST', headers: { 'Content-Type': 'application/json',
      Authorization: `Bearer ${ingestToken}`, 'X-FluxScale-Execution-Mode': 'observe_only' },
    body: JSON.stringify({ service, instance_id: 'recovery-instance', timestamp: new Date().toISOString(),
      requests_per_second: rps, active_requests: 0, p95_latency_ms: 50,
      error_rate: 0, cpu_percent: 10, memory_percent: 10, current_replicas: 1 }),
  });
  assert.equal(accepted.accepted, true);
  await poll(async () => JSON.parse(await readFile(statePath, 'utf8'))
    .services[service]?.decisions.some(decision => decision.id === accepted.decision.id), 'durable accepted decision');
  return accepted.decision.id;
}

async function assertRestored(source, decisionIds) {
  const health = await request('/api/v1/persistence');
  assert.equal(health.restore_source, source);
  assert.equal(health.restored_services, 1);
  assert.equal(health.restored_metric_samples, decisionIds.length);
  assert.equal(health.restored_decisions, decisionIds.length);
  const decisions = await request('/api/v1/decisions');
  assert.deepEqual(decisions.map(decision => decision.id).sort(), [...decisionIds].sort());
}

try {
  const servers = [createServer(), createServer()];
  let ports;
  try {
    await Promise.all(servers.map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
    ports = servers.map(server => server.address().port);
  } finally {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  }
  url = `http://127.0.0.1:${ports[0]}`;
  await writeFile(configPath, `[server]\nbind="127.0.0.1:${ports[0]}"\n[proxy]\nbind="127.0.0.1:${ports[1]}"\n[security]\nenabled=true\n[docker]\nenabled=false\n`);
  const source = join(process.env.CARGO_TARGET_DIR ?? join(process.env.LOCALAPPDATA, 'FluxScale/target'), 'debug/fluxscale-core.exe');
  // Freeze both artifacts so a concurrent build cannot change this rehearsal.
  const saved = join(root, 'saved-controller.exe');
  const candidate = join(root, 'candidate-controller.exe');
  await copyFile(source, saved);
  await copyFile(saved, candidate);
  const artifactHash = createHash('sha256').update(await readFile(saved)).digest('hex');

  await start(saved);
  const version = (await request('/health')).version;
  const first = await ingest('recovery-demo', 10);
  const second = await ingest('recovery-demo', 20);
  await stop();
  const offline = join(root, 'offline-backup');
  await mkdir(offline);
  await copyFile(statePath, join(offline, 'state.json'));
  await copyFile(`${statePath}.bak`, join(offline, 'state.json.bak'));
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).schema_version, 1);

  await start(candidate);
  await assertRestored('primary', [first, second]);
  const third = await ingest('after-switch', 30);
  assert((await request('/api/v1/decisions')).some(decision => decision.id === third));
  await stop();
  await copyFile(join(offline, 'state.json'), statePath);
  await copyFile(join(offline, 'state.json.bak'), `${statePath}.bak`);
  await start(saved);
  await assertRestored('primary', [first, second]);
  assert.equal((await request('/api/v1/services')).length, 1);
  await stop();
  console.log('[PASS] Offline checkpoint pair restored with saved artifact; later service/decision absent');

  await copyFile(join(offline, 'state.json.bak'), `${statePath}.bak`);
  await writeFile(statePath, '{broken primary');
  await start(candidate);
  await assertRestored('backup', [first]);
  await stop();
  const quarantined = (await readdir(root)).filter(name => name.startsWith('state.json.corrupt-'));
  assert.equal(quarantined.length, 1);
  assert.equal(await readFile(join(root, quarantined[0]), 'utf8'), '{broken primary');
  await start(saved);
  await assertRestored('primary', [first]);
  await stop();
  console.log('[PASS] Corrupt primary preserved, last good backup recovered, repaired checkpoint survives restart');

  // A directory at the checkpoint path makes persistence impossible on Windows and Linux.
  await copyFile(statePath, join(root, 'repaired-state.json'));
  await unlink(statePath);
  await mkdir(statePath);
  await start(candidate, true);
  await stop();
  console.log('[PASS] Unusable state path prevents startup and API availability');
  await writeFile(join(root, 'result.json'), JSON.stringify({ version, artifact_sha256: artifactHash,
    same_version_rehearsal: true, schema_version: 1, offline_restore: 'passed',
    corrupt_primary_recovery: 'passed', repaired_restart: 'passed', unusable_state_path: 'passed' }, null, 2));
  console.log(`PASS: Schema-1 recovery and same-version artifact rollback rehearsal. Evidence: ${root}`);
} finally {
  await stop();
}
