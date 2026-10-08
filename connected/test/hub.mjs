import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHub } from '../server.mjs';
import { token, digest } from '../store.mjs';
import { validateEndpoint } from '../agent.mjs';

test('accounts, CSRF, project isolation, one-use enrollment, real reports, revocation and password invalidation', async t => {
  const hub = createHub({ database: ':memory:', origin: 'http://127.0.0.1:8090', dashboard: null });
  hub.server.listen(0, '127.0.0.1'); await once(hub.server, 'listening');
  t.after(async () => { hub.server.close(); await once(hub.server, 'close'); });
  const url = `http://127.0.0.1:${hub.server.address().port}`;
  async function call(path, method = 'GET', data, identity, extra = {}) {
    const response = await fetch(url + path, { method, headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:8090', ...(identity?.cookie ? { Cookie: identity.cookie, 'X-CSRF-Token': identity.csrf } : {}), ...extra }, body: data === undefined ? undefined : JSON.stringify(data) });
    const result = await response.json(); return { status: response.status, data: result, cookie: response.headers.get('set-cookie')?.split(';')[0], csrf: result.csrf };
  }
  async function register(email) { const invite = token(); hub.db.prepare('INSERT INTO invites VALUES(?,?,?)').run(digest(invite), email, Date.now() + 60000); const result = await call('/api/auth/register', 'POST', { email, password: 'very-strong-password-1234', invite }); assert.equal(result.status, 200); assert.match(result.cookie, /^fluxscale_local=/); return result; }
  assert.equal((await call('/api/auth/register', 'POST', { email: 'a@test.dev', password: 'very-strong-password-1234', invite: token() })).status, 403);
  const a = await register('a@test.dev'); const b = await register('b@test.dev');
  assert.equal((await call('/api/auth/me', 'GET', undefined, a)).data.email, 'a@test.dev');
  const policy = { enabled: false, min_replicas: 1, max_replicas: 3 };
  assert.equal((await call('/api/projects', 'POST', { name: 'Orders', service: 'orders', policy }, a, { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await call('/api/projects', 'POST', { name: 'Orders', service: 'orders', policy }, a, { Origin: 'https://evil.test' })).status, 403);
  const project = await call('/api/projects', 'POST', { name: 'Orders', service: 'orders', policy }, a); assert.equal(project.status, 201);
  const path = `/api/projects/${project.data.id}`;
  const other = await call('/api/projects', 'POST', { name: 'Other Orders', service: 'orders', policy }, b); assert.equal(other.status, 201);
  for (const [suffix, method, data] of [['', 'GET'], ['/policy', 'POST', policy], ['/enrollment', 'POST', {}], ['/host', 'DELETE']]) assert.equal((await call(path + suffix, method, data, b)).status, 404);
  assert.equal((await call('/api/projects', 'GET', undefined, b)).data.length, 1);
  const enrollment = await call(path + '/enrollment', 'POST', {}, a);
  const enrolled = await call('/api/agent/enroll', 'POST', { token: enrollment.data.token }); assert.equal(enrolled.status, 201);
  assert.equal((await call('/api/agent/enroll', 'POST', { token: enrollment.data.token })).status, 401);
  const authorization = { Authorization: `Bearer ${enrolled.data.credential}` };
  const report = { service: 'orders', applied_version: 0, snapshot: { ready: true, metrics: [{ timestamp: new Date().toISOString(), requests_per_second: 123, p95_latency_ms: 50, error_rate: 0, cpu_percent: 10, memory_percent: 20, secret: 'DO-NOT-STORE' }], backends: [{ container_name: 'orders-1', healthy: true, draining: false, in_flight: 0, url: 'DO-NOT-STORE', environment: 'DO-NOT-STORE' }], decisions: [] } };
  assert.equal((await call('/api/agent/report', 'POST', { ...report, snapshot: { ...report.snapshot, metrics: [{ ...report.snapshot.metrics[0], requests_per_second: 'invalid' }] } }, null, authorization)).status, 400);
  assert.equal((await call('/api/agent/report', 'POST', { ...report, service: 'other' }, null, authorization)).status, 400);
  assert.equal((await call('/api/agent/report', 'POST', report, null, authorization)).status, 200);
  const detail = await call(path, 'GET', undefined, a); assert.equal(detail.data.host.online, true); assert.equal(detail.data.host.snapshot.metrics[0].requests_per_second, 123); assert(!JSON.stringify(detail.data).includes('DO-NOT-STORE')); assert(!JSON.stringify(detail.data).includes(enrolled.data.credential));
  const console = { overview: { services: [{ service: 'orders' }], recent_decisions: [] }, health: { status: 'ok' }, instances: { service: 'orders', instances: [] }, audit: { events: [] } };
  assert.equal((await call('/api/agent/report', 'POST', { ...report, snapshot: { ...report.snapshot, console: { ...console, instances: { service: 'foreign-project', instances: [] } } } }, null, authorization)).status, 400);
  assert.equal((await call('/api/agent/report', 'POST', { ...report, snapshot: { ...report.snapshot, console } }, null, authorization)).status, 200);
  assert.equal((await call(path + '/console/health', 'GET', undefined, a)).data.workspace, 'a@test.dev / Orders');
  assert.equal((await call(path + '/console/api/v1/dashboard/overview', 'GET', undefined, b)).status, 404);
  assert.equal((await call(path + '/console/api/v1/services/foreign/metrics', 'GET', undefined, a)).status, 404);
  const updated = await call(path + '/policy', 'POST', { ...policy, enabled: true }, a); assert.equal(updated.data.version, 2);
  assert.equal((await call('/api/agent/report', 'POST', report, null, authorization)).data.policy.enabled, true);
  assert.equal((await call(path + '/policy', 'POST', { ...policy, max_replicas: 0 }, a)).status, 400);
  await call(path + '/host', 'DELETE', undefined, a);
  assert.equal((await call('/api/agent/report', 'POST', report, null, authorization)).status, 401);
  const audit = await call('/api/audit', 'GET', undefined, b); assert(audit.data.every(v => v.project_id === other.data.id));
  assert.equal((await call('/api/auth/password', 'POST', { current_password: 'very-strong-password-1234', password: 'replacement-strong-password' }, a)).status, 200);
  assert.equal((await call('/api/auth/me', 'GET', undefined, a)).status, 401);
  assert.equal((await call('/api/auth/login', 'POST', { email: 'a@test.dev', password: 'very-strong-password-1234' })).status, 401);
  assert.equal((await call('/api/auth/login', 'POST', { email: 'a@test.dev', password: 'replacement-strong-password' })).status, 200);
});
test('endpoints prevent remote plaintext enrollment and controller credential exfiltration', () => {
  assert.equal(validateEndpoint('https://hub.example'), 'https://hub.example');
  assert.equal(validateEndpoint('http://127.0.0.1:8080', true), 'http://127.0.0.1:8080');
  for (const endpoint of ['http://hub.example', 'https://user:secret@hub.example', 'https://hub.example/path', 'https://hub.example/?secret=value']) assert.throws(() => validateEndpoint(endpoint));
  assert.throws(() => validateEndpoint('https://remote-controller.example', true));
});
