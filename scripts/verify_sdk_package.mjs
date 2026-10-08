import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const project = fileURLToPath(new URL('../', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'fluxscale-sdk-consumer-'));
const exec = promisify(execFile);
const sdkLock = JSON.parse(await readFile(join(project, 'sdk/node/package-lock.json'), 'utf8'));
const tarball = join(project, 'artifacts/fluxscale-node-0.1.0.tgz');
await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: {
  '@fluxscale/node': 'file:' + tarball.replaceAll('\\', '/'), express: sdkLock.packages['node_modules/express'].version,
} }));
const npm = process.platform === 'win32' ? ['cmd.exe', ['/d', '/s', '/c', 'npm install --ignore-scripts --no-audit --no-fund']]
  : ['npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund']];
await exec(npm[0], npm[1], { cwd: root, windowsHide: true, timeout: 120_000 });
await writeFile(join(root, 'check.mjs'), `
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import express from 'express';
import { createFluxScale } from '@fluxscale/node';
const samples = [];
const controller = createServer(async (request, response) => {
  assert.equal(request.headers['x-fluxscale-execution-mode'], 'observe_only');
  let body = '';
  for await (const chunk of request) body += chunk;
  samples.push(JSON.parse(body));
  response.writeHead(202, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ accepted: true, decision: { action: 'hold', desired_replicas: 1 } }));
});
await new Promise(resolve => controller.listen(0, '127.0.0.1', resolve));
const telemetry = createFluxScale({ service: 'consumer-orders', instanceId: 'consumer-instance',
  endpoint: 'http://127.0.0.1:' + controller.address().port, flushIntervalMs: 60_000 });
const app = express();
app.use(telemetry.middleware);
app.get('/health', (_request, response) => response.json({ ok: true }));
app.get('/api/orders', (_request, response) => response.json({ orders: [] }));
app.get('/api/failure', (_request, response) => response.status(500).json({ error: 'expected test failure' }));
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
try {
  const url = 'http://127.0.0.1:' + server.address().port;
  assert.equal((await fetch(url + '/api/orders')).status, 200);
  assert.equal((await fetch(url + '/api/failure')).status, 500);
  assert.equal((await fetch(url + '/health')).status, 200);
  assert.equal((await telemetry.flush()).accepted, true);
  assert.equal(samples.length, 1);
  const sample = samples[0];
  assert.equal(sample.service, 'consumer-orders');
  assert.equal(sample.instance_id, 'consumer-instance');
  assert.equal(sample.active_requests, 0);
  assert.equal(sample.error_rate, 0.5);
  assert(sample.requests_per_second > 0);
  assert(Number.isFinite(sample.p95_latency_ms));
} finally {
  await telemetry.close();
  await Promise.all([server, controller].map(server => new Promise(resolve => server.close(resolve))));
}
console.log('PASS: Installed SDK tarball instruments a fresh Express application; ignored health and error ratio verified.');
`);
const { stdout } = await exec(process.execPath, ['check.mjs'], { cwd: root, windowsHide: true, timeout: 20_000 });
assert(stdout.includes('PASS:'));
console.log(stdout.trim());
console.log(`Consumer install evidence: ${root}`);
