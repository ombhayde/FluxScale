import assert from 'node:assert/strict';
import { once } from 'node:events';
import { join } from 'node:path';
import { createHub } from './server.mjs';
import { token, digest } from './store.mjs';
import { enroll, cycle } from './agent.mjs';

// Used by the real deployment verifier; no Docker topology is simulated here.
export async function connectDeployment({ root, controller, service, readToken, managedToken }) {
  const hub = createHub({ database: join(root, 'connected.sqlite'), origin: 'http://127.0.0.1:8090', dashboard: null });
  hub.server.listen(0, '127.0.0.1'); await once(hub.server, 'listening');
  const base = `http://127.0.0.1:${hub.server.address().port}`; let identity; let config; let stopping = false; let worker;
  const saved = { read: process.env.FLUXSCALE_READ_TOKEN, managed: process.env.FLUXSCALE_MANAGED_TOKEN };
  process.env.FLUXSCALE_READ_TOKEN = readToken; process.env.FLUXSCALE_MANAGED_TOKEN = managedToken;
  async function call(path, method = 'GET', data) {
    const response = await fetch(base + path, { method, headers: { Origin: 'http://127.0.0.1:8090', 'Content-Type': 'application/json', ...(identity ? { Cookie: identity.cookie, 'X-CSRF-Token': identity.csrf } : {}) }, body: data === undefined ? undefined : JSON.stringify(data) });
    assert(response.ok, `Hub ${response.status}: ${await response.clone().text()}`); return { data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  try {
    const invite = token(); hub.db.prepare('INSERT INTO invites VALUES(?,?,?)').run(digest(invite), 'deployment@test.dev', Date.now() + 60000);
    const registration = await call('/api/auth/register', 'POST', { email: 'deployment@test.dev', password: token(), invite }); identity = { cookie: registration.cookie, csrf: registration.data.csrf };
    const project = (await call('/api/projects', 'POST', { name: 'Actual deployment', service, policy: { enabled: false, min_replicas: 1, max_replicas: 3 } })).data;
    const path = `/api/projects/${project.id}`;
    const enrollment = (await call(path + '/enrollment', 'POST', {})).data;
    config = await enroll({ hub: base, controller, service }, enrollment.token);
    config = await cycle(config); config = await cycle(config);
    assert.equal(config.applied_version, 1); assert.equal(config.last_error, false);
    const detail = (await call(path)).data; assert(detail.host.snapshot.ready); assert.equal(detail.host.applied_version, 1);
    worker = (async () => { while (!stopping) { try { config = await cycle(config); } catch (error) { if (!stopping) console.error(`Verification host temporarily disconnected: ${error.message}`); } if (!stopping) await new Promise(resolve => setTimeout(resolve, 5000)); } })();
    return {
      async policy(enabled, max = 3) { const response = (await call(path + '/policy', 'POST', { enabled, min_replicas: 1, max_replicas: max })).data; return response.version; },
      async detail() { return (await call(path)).data; },
      async close() { stopping = true; await worker; hub.server.close(); await once(hub.server, 'close'); for (const [key, value] of [['FLUXSCALE_READ_TOKEN', saved.read], ['FLUXSCALE_MANAGED_TOKEN', saved.managed]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } },
    };
  } catch (error) { stopping = true; hub.server.close(); await once(hub.server, 'close'); for (const [key, value] of [['FLUXSCALE_READ_TOKEN', saved.read], ['FLUXSCALE_MANAGED_TOKEN', saved.managed]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } throw error; }
}
