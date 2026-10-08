import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function validateEndpoint(value, local = false) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error('Endpoint must be an origin without credentials');
  if (local ? !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) : url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw Error('Hub requires HTTPS; controller must use loopback');
  if (!['http:', 'https:'].includes(url.protocol)) throw Error('Invalid protocol');
  return url.origin;
}
async function json(url, options = {}, allowMissing = false) {
  const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(10000) });
  if (allowMissing && response.status === 404) return [];
  if (!response.ok) throw Error(`Request rejected (${response.status})`);
  const reader = response.body.getReader(); const chunks = []; let bytes = 0;
  try { while (true) { const { value, done } = await reader.read(); if (done) break; bytes += value.length; if (bytes > 1024 * 1024) throw Error('Response too large'); chunks.push(Buffer.from(value)); } }
  finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(chunks).toString());
}
export async function enroll(config, enrollment) {
  const hub = validateEndpoint(config.hub); validateEndpoint(config.controller, true);
  if (!/^[a-zA-Z0-9_.-]{1,128}$/.test(config.service)) throw Error('Invalid service');
  const identity = await json(`${hub}/api/agent/enroll`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: enrollment }) });
  if (identity.service !== config.service || !/^[A-Za-z0-9_-]{43}$/.test(identity.credential)) throw Error('Enrollment service does not match local deployment');
  return { ...config, credential: identity.credential, host_id: identity.host_id };
}
export async function cycle(config, { readToken = process.env.FLUXSCALE_READ_TOKEN, managedToken = process.env.FLUXSCALE_MANAGED_TOKEN } = {}) {
  const hub = validateEndpoint(config.hub); const local = validateEndpoint(config.controller, true); const service = config.service;
  const read = { headers: { Authorization: `Bearer ${readToken}` } };
  const managed = { Authorization: `Bearer ${managedToken}`, 'Content-Type': 'application/json' };
  let snapshot; let applied = config.applied_version ?? 0;
  try {
    const [ready, metrics, backends, decisions, overview, health, instances, audit] = await Promise.all([
      json(`${local}/api/v1/observability/ready`, read), json(`${local}/api/v1/services/${service}/metrics`, read, true),
      json(`${local}/api/v1/backends/${service}`, read), json(`${local}/api/v1/decisions`, read),
      json(`${local}/api/v1/dashboard/overview`, read), json(`${local}/health`, read), json(`${local}/api/v1/services/${service}/instances`, read, true), json(`${local}/api/v1/audit`, read),
    ]);
    overview.services = overview.services.filter(v => v.service === service);
    overview.recent_decisions = overview.recent_decisions.filter(v => v.service === service);
    snapshot = { ready: ready.status === 'ok', metrics: metrics.slice(-120), backends: backends.backends.slice(0, 100).map(v => ({ container_name: v.name, healthy: v.healthy, draining: v.draining, in_flight: v.active_requests })), decisions: decisions.filter(v => v.service === service).slice(0,50), console: { overview, health, instances: Array.isArray(instances) ? { service, instances: [] } : instances, audit: { ...audit, events: audit.events.slice(-100).map(v => ({ timestamp:v.timestamp,request_id:v.request_id,method:v.method,path:v.path,request_class:v.request_class,status:v.status,latency_ms:v.latency_ms,rate_limited:v.rate_limited })) } }, error: config.last_error ?? false };
  } catch { snapshot = { ready: false, metrics: [], backends: [], decisions: [], error: true }; }
  const response = await json(`${hub}/api/agent/report`, { method: 'POST', headers: { Authorization: `Bearer ${config.credential}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ service, applied_version: applied, snapshot }) });
  if (response.service !== service) throw Error('Policy service mismatch');
  const policy = response.policy;
  if (!policy || !Number.isSafeInteger(policy.version) || policy.version < applied || typeof policy.enabled !== 'boolean' || !Number.isSafeInteger(policy.min_replicas) || !Number.isSafeInteger(policy.max_replicas) || policy.min_replicas < 1 || policy.max_replicas < policy.min_replicas || policy.max_replicas > 100) throw Error('Invalid policy received');
  // Replay the same version: the local controller verifies persistence and idempotency.
  try {
    await json(`${local}/api/v1/services/${service}/policy`, { method: 'POST', headers: managed, body: JSON.stringify(policy) });
    applied = policy.version; return { ...config, applied_version: applied, last_error: false };
  } catch { return { ...config, applied_version: applied, last_error: true }; }
}
async function save(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`; await writeFile(temporary, JSON.stringify(value, null, 2), { mode: 0o600 }); await rename(temporary, path);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = resolve(process.argv[2] ?? 'data/agent.json'); let config = JSON.parse(await readFile(path, 'utf8'));
  if (!process.env.FLUXSCALE_READ_TOKEN || !process.env.FLUXSCALE_MANAGED_TOKEN) throw Error('Local read and managed credentials required');
  if (!config.credential) { if (!process.env.FLUXSCALE_ENROLLMENT_TOKEN) throw Error('One-use enrollment token required'); config = await enroll(config, process.env.FLUXSCALE_ENROLLMENT_TOKEN); await save(path, config); delete process.env.FLUXSCALE_ENROLLMENT_TOKEN; }
  let stopping = false; for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; });
  while (!stopping) {
    try { config = await cycle(config); await save(path, config); }
    catch (error) { console.error(`Host connection failed: ${error.message}; local controller keeps its last policy`); }
    if (!stopping) await new Promise(resolve => setTimeout(resolve, 5000));
  }
}
