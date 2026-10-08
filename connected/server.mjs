import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, transaction, token, digest, passwordHash, equal } from './store.mjs';

class Rejection extends Error { constructor(status, message) { super(message); this.status = status; } }
const reject = (status, message) => { throw new Rejection(status, message); };
const text = (value, min, max) => typeof value === 'string' && value.length >= min && value.length <= max;
const serviceName = value => text(value, 1, 128) && /^[a-zA-Z0-9_.-]+$/.test(value);
const emailValid = value => text(value, 3, 254) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const validPassword = value => text(value, 12, 128);
const policyValid = p => p && typeof p.enabled === 'boolean' && Number.isSafeInteger(p.min_replicas) && Number.isSafeInteger(p.max_replicas) && p.min_replicas >= 1 && p.max_replicas >= p.min_replicas && p.max_replicas <= 100;
const epoch = () => Date.now();
async function body(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') reject(415, 'Use application/json');
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) reject(413, 'Request too large'); chunks.push(chunk); }
  try { const data = JSON.parse(Buffer.concat(chunks).toString()); if (!data || typeof data !== 'object' || Array.isArray(data)) reject(400, 'Object required'); return data; }
  catch (error) { if (error instanceof Rejection) throw error; reject(400, 'Invalid JSON'); }
}
export function createHub({ database = 'data/connected.sqlite', origin = 'http://127.0.0.1:8090', dashboard = '../dashboard-react/dist' } = {}) {
  const publicURL = new URL(origin);
  if (publicURL.origin !== origin || publicURL.username || publicURL.password || (publicURL.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(publicURL.hostname))) throw Error('Public origin must be HTTPS, or loopback HTTP');
  const db = openStore(database); const secure = publicURL.protocol === 'https:';
  const cookieName = secure ? '__Host-fluxscale' : 'fluxscale_local';
  const rates = new Map(); let passwordJobs = 0;
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const audit = (user, project, event) => { run('INSERT INTO audit(user_id,project_id,event,at) VALUES(?,?,?,?)', user, project, event, epoch()); run('DELETE FROM audit WHERE user_id=? AND id NOT IN (SELECT id FROM audit WHERE user_id=? ORDER BY id DESC LIMIT 2000)', user, user); };
  async function hash(password, salt) { if (passwordJobs >= 2) reject(429, 'Authentication busy; retry shortly'); passwordJobs++; try { return await passwordHash(password, salt); } finally { passwordJobs--; } }
  function rate(key, limit) {
    const now = epoch(); for (const [k, v] of rates) if (v.until <= now) rates.delete(k);
    const existing = rates.get(key);
    if (!existing && rates.size >= 4096) reject(429, 'Request limit reached');
    const entry = existing ?? { until: now + 60000, count: 0 }; entry.count++; rates.set(key, entry);
    if (entry.count > limit) reject(429, 'Too many requests; retry in a minute');
  }
  function session(req, mutation) {
    const cookie = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    const current = cookie && one('SELECT sessions.*,users.email FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.hash=? AND expires>?', digest(cookie), epoch());
    if (!current) reject(401, 'Sign in required');
    if (mutation && !equal(req.headers['x-csrf-token'], current.csrf)) reject(403, 'Invalid request token');
    return current;
  }
  function projectFor(id, user) { const project = one('SELECT * FROM projects WHERE id=? AND user_id=?', id, user); if (!project) reject(404, 'Project not found'); return project; }
  function agent(req) {
    const credential = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
    const host = credential && one('SELECT hosts.*,projects.service,projects.policy FROM hosts JOIN projects ON projects.id=hosts.project_id WHERE credential=? AND revoked=0', digest(credential));
    if (!host) reject(401, 'Host credential invalid or revoked'); return host;
  }
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const send = (status, data) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
    try {
      const path = new URL(req.url, 'http://local').pathname; const mutation = req.method !== 'GET';
      rate(req.socket.remoteAddress ?? 'unknown', 600);
      if (mutation && !path.startsWith('/api/agent/') && req.headers.origin !== origin) reject(403, 'Origin not allowed');
      if (req.method === 'GET' && path === '/api/connected') return send(200, { connected: true });
      if (req.method === 'GET' && path === '/health') { one('SELECT 1'); return send(200, { status: 'ok', mode: 'connected', version: '0.1.0' }); }
      if (req.method === 'POST' && ['/api/auth/register', '/api/auth/login'].includes(path)) {
        rate(`auth:${req.socket.remoteAddress}`, 12); const data = await body(req);
        const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
        if (!emailValid(email) || !validPassword(data.password)) reject(400, 'Use a valid email and a password of 12–128 characters');
        let user;
        if (path.endsWith('register')) {
          if (!text(data.invite, 43, 43)) reject(403, 'Valid invitation required');
          const password = await hash(data.password);
          user = transaction(db, () => {
            const invite = one('SELECT * FROM invites WHERE hash=? AND email=? AND expires>?', digest(data.invite), email, epoch());
            if (!invite || one('SELECT id FROM users WHERE email=?', email)) reject(403, 'Invitation invalid or already used');
            const id = token(); run('INSERT INTO users VALUES(?,?,?,?)', id, email, password.salt, password.hash); run('DELETE FROM invites WHERE hash=?', invite.hash); return { id, email };
          });
        } else {
          user = one('SELECT * FROM users WHERE email=?', email);
          const password = await hash(data.password, user?.salt ?? 'unknown-user-salt');
          if (!user || !equal(user.hash, password.hash)) reject(401, 'Email or password incorrect');
        }
        run('DELETE FROM sessions WHERE expires<?', epoch());
        const credential = token(); const csrf = token();
        transaction(db, () => { run('INSERT INTO sessions VALUES(?,?,?,?)', digest(credential), user.id, csrf, epoch() + 12 * 3600000); run('DELETE FROM sessions WHERE user_id=? AND hash NOT IN (SELECT hash FROM sessions WHERE user_id=? ORDER BY expires DESC LIMIT 10)', user.id, user.id); });
        res.setHeader('Set-Cookie', `${cookieName}=${credential}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure ? '; Secure' : ''}`);
        return send(200, { email, csrf });
      }
      if (path.startsWith('/api/agent/')) {
        if (req.method !== 'POST') reject(405, 'POST required'); const data = await body(req);
        if (path === '/api/agent/enroll') {
          rate(`enroll:${req.socket.remoteAddress}`, 12);
          if (!text(data.token, 43, 43)) reject(401, 'Enrollment invalid');
          const credential = token(); const hostId = token();
          const project = transaction(db, () => {
            const enrollment = one('SELECT * FROM enrollments WHERE hash=? AND expires>?', digest(data.token), epoch()); if (!enrollment) reject(401, 'Enrollment expired or used');
            if (one('SELECT id FROM hosts WHERE project_id=?', enrollment.project_id)) reject(409, 'Revoke the existing host before reconnecting');
            run('INSERT INTO hosts(id,project_id,credential) VALUES(?,?,?)', hostId, enrollment.project_id, digest(credential)); run('DELETE FROM enrollments WHERE project_id=?', enrollment.project_id);
            return one('SELECT * FROM projects WHERE id=?', enrollment.project_id);
          });
          audit(project.user_id, project.id, 'host_enrolled');
          return send(201, { credential, host_id: hostId, service: project.service });
        }
        const host = agent(req); rate(`host:${host.id}`, 30);
        if (path !== '/api/agent/report') reject(404, 'Endpoint not found');
        if (data.service !== host.service || !Number.isSafeInteger(data.applied_version) || data.applied_version < 0 || data.applied_version > JSON.parse(host.policy).version) reject(400, 'Invalid host report');
        const snapshot = data.snapshot;
        if (!snapshot || typeof snapshot.ready !== 'boolean' || !Array.isArray(snapshot.metrics) || !Array.isArray(snapshot.backends) || !Array.isArray(snapshot.decisions) || snapshot.metrics.length > 120 || snapshot.backends.length > 100 || snapshot.decisions.length > 50) reject(400, 'Invalid snapshot');
        const number = (value, max = Number.MAX_SAFE_INTEGER) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;
        const timestamp = value => text(value, 1, 64) && Number.isFinite(Date.parse(value));
        if (snapshot.metrics.some(v => !timestamp(v?.timestamp) || !number(v.requests_per_second) || !number(v.p95_latency_ms) || !number(v.error_rate, 1) || !number(v.cpu_percent, 100) || !number(v.memory_percent, 100))
          || snapshot.backends.some(v => !serviceName(v?.container_name) || typeof v.healthy !== 'boolean' || typeof v.draining !== 'boolean' || !Number.isSafeInteger(v.in_flight) || v.in_flight < 0)
          || snapshot.decisions.some(v => !timestamp(v?.timestamp) || !['hold','scale_up','scale_down'].includes(v.action) || !Number.isSafeInteger(v.desired_replicas) || v.desired_replicas < 1 || v.desired_replicas > 100)) reject(400, 'Invalid telemetry fields');
        // Accept only known display fields; host-local tokens and environment never enter the hub.
        const select = (v, keys) => Object.fromEntries(keys.filter(k => typeof v?.[k] === 'string' || typeof v?.[k] === 'number' || typeof v?.[k] === 'boolean').map(k => [k, v[k]]));
        const clean = { ready: snapshot.ready, metrics: snapshot.metrics.map(v => select(v, ['timestamp','requests_per_second','p95_latency_ms','error_rate','cpu_percent','memory_percent','current_replicas','active_requests'])), backends: snapshot.backends.map(v => select(v, ['container_name','healthy','draining','in_flight'])), decisions: snapshot.decisions.map(v => select(v, ['timestamp','action','desired_replicas','predicted_rps'])), error: snapshot.error ? 'Local controller unavailable or policy rejected; inspect host logs' : null };
        if (snapshot.console) {
          const c = snapshot.console;
          if (!Array.isArray(c.overview?.services) || c.overview.services.some(v => v.service !== host.service)
            || !Array.isArray(c.overview?.recent_decisions) || c.overview.recent_decisions.some(v => v.service !== host.service)
            || c.instances?.service !== host.service || !Array.isArray(c.instances?.instances) || c.instances.instances.length > 100
            || !Array.isArray(c.audit?.events) || c.audit.events.length > 100 || !c.health) reject(400, 'Console report is outside project scope');
          clean.console = c;
        }
        run('UPDATE hosts SET last_seen=?,snapshot=?,applied_version=? WHERE id=?', epoch(), JSON.stringify(clean), data.applied_version, host.id);
        return send(200, { policy: JSON.parse(host.policy), service: host.service });
      }
      if (path.startsWith('/api/')) {
        const current = session(req, mutation); const user = current.user_id;
        if (path === '/api/auth/me' && req.method === 'GET') return send(200, { email: current.email, csrf: current.csrf });
        if (path === '/api/auth/logout' && req.method === 'POST') { run('DELETE FROM sessions WHERE hash=?', current.hash); res.setHeader('Set-Cookie', `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`); return send(200, { ok: true }); }
        if (path === '/api/auth/password' && req.method === 'POST') {
          const data = await body(req); if (!validPassword(data.password) || !validPassword(data.current_password)) reject(400, 'Invalid password');
          const existing = one('SELECT * FROM users WHERE id=?', user); const old = await hash(data.current_password, existing.salt); if (!equal(existing.hash, old.hash)) reject(401, 'Current password incorrect');
          const next = await hash(data.password); transaction(db, () => { run('UPDATE users SET salt=?,hash=? WHERE id=?', next.salt, next.hash, user); run('DELETE FROM sessions WHERE user_id=?', user); }); return send(200, { ok: true });
        }
        if (path === '/api/projects' && req.method === 'GET') return send(200, all('SELECT id,name,service,policy FROM projects WHERE user_id=? ORDER BY name', user).map(p => ({ ...p, policy: JSON.parse(p.policy) })));
        if (path === '/api/projects' && req.method === 'POST') {
          const data = await body(req); if (!text(data.name, 1, 80) || !serviceName(data.service) || !policyValid(data.policy)) reject(400, 'Invalid project or scaling bounds');
          if (one('SELECT COUNT(*) AS n FROM projects WHERE user_id=?', user).n >= 20) reject(409, 'Project limit reached');
          if (!data.name.trim()) reject(400, 'Project name required');
          const id = token(); run('INSERT INTO projects VALUES(?,?,?,?,?)', id, user, data.name.trim(), data.service, JSON.stringify({ enabled: data.policy.enabled, min_replicas: data.policy.min_replicas, max_replicas: data.policy.max_replicas, version: 1 })); audit(user, id, 'project_created'); return send(201, { id });
        }
        if (path === '/api/audit' && req.method === 'GET') return send(200, all('SELECT project_id,event,at FROM audit WHERE user_id=? ORDER BY id DESC LIMIT 100', user));
        const consoleRoute = path.match(/^\/api\/projects\/([A-Za-z0-9_-]{43})\/console(\/.*)$/);
        if (consoleRoute) {
          if (req.method !== 'GET') reject(405, 'Console is read-only');
          const project = projectFor(consoleRoute[1], user);
          const host = one('SELECT snapshot,last_seen FROM hosts WHERE project_id=? AND revoked=0', project.id);
          if (!host?.snapshot || host.last_seen < epoch()-30000) reject(503, 'Deployment report unavailable or stale');
          const snapshot = JSON.parse(host.snapshot); const console = snapshot.console; const endpoint = consoleRoute[2];
          if (!console) reject(503, 'Waiting for console report');
          if (endpoint === '/health') return send(200, { ...console.health, workspace: `${current.email} / ${project.name}` });
          if (endpoint === '/api/v1/dashboard/overview') return send(200, console.overview);
          if (endpoint === '/api/v1/audit') return send(200, console.audit);
          if (endpoint === `/api/v1/services/${project.service}/metrics`) return send(200, snapshot.metrics);
          if (endpoint === `/api/v1/services/${project.service}/instances`) return send(200, console.instances);
          reject(404, 'Project console endpoint not found');
        }
        const match = path.match(/^\/api\/projects\/([A-Za-z0-9_-]{43})(?:\/(enrollment|policy|host))?$/);
        if (!match) reject(404, 'Endpoint not found'); const project = projectFor(match[1], user);
        if (req.method === 'GET' && !match[2]) {
          const host = one('SELECT id,last_seen,snapshot,applied_version FROM hosts WHERE project_id=? AND revoked=0', project.id);
          return send(200, { ...project, user_id: undefined, policy: JSON.parse(project.policy), host: host ? { ...host, snapshot: host.snapshot ? JSON.parse(host.snapshot) : null, online: host.last_seen > epoch() - 30000 } : null });
        }
        if (req.method === 'POST' && match[2] === 'enrollment') {
          const enrollment = token(); run('DELETE FROM enrollments WHERE expires<? OR project_id=?', epoch(), project.id); run('INSERT INTO enrollments VALUES(?,?,?)', digest(enrollment), project.id, epoch() + 600000); audit(user, project.id, 'enrollment_created'); return send(201, { token: enrollment, expires_in_seconds: 600 });
        }
        if (req.method === 'POST' && match[2] === 'policy') {
          const data = await body(req); if (!policyValid(data)) reject(400, 'Invalid policy');
          const policy = { enabled: data.enabled, min_replicas: data.min_replicas, max_replicas: data.max_replicas, version: JSON.parse(project.policy).version + 1 };
          run('UPDATE projects SET policy=? WHERE id=?', JSON.stringify(policy), project.id); audit(user, project.id, policy.enabled ? 'autoscaling_enabled' : 'autoscaling_paused'); return send(200, policy);
        }
        if (req.method === 'DELETE' && match[2] === 'host') {
          transaction(db, () => { run('DELETE FROM hosts WHERE project_id=?', project.id); run('DELETE FROM enrollments WHERE project_id=?', project.id); }); audit(user, project.id, 'host_revoked'); return send(200, { ok: true });
        }
        reject(405, 'Method not allowed');
      }
      if (req.method !== 'GET' || !dashboard) reject(404, 'Not found');
      if (path === '/') { res.writeHead(302, { Location: '/connected' }); return res.end(); }
      const consolePage = path.match(/^\/projects\/([A-Za-z0-9_-]{43})\/console\/?$/);
      if (consolePage) projectFor(consolePage[1], session(req, false).user_id);
      const base = resolve(dashboard); const relative = path === '/' || path === '/connected' || consolePage ? 'index.html' : decodeURIComponent(path).replace(/^\/+/, '');
      const file = resolve(base, relative); if (file !== base && !file.startsWith(base + (process.platform === 'win32' ? '\\' : '/'))) reject(404, 'Not found');
      const bytes = await readFile(file); const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };
      res.setHeader('Content-Type', mime[extname(file)] ?? 'application/octet-stream'); res.end(bytes);
    } catch (error) { const status = error instanceof Rejection ? error.status : error.code === 'ENOENT' ? 404 : 500; if (status === 500) console.error('Connected request failed:', error.code ?? error.name); if (!res.headersSent) send(status, { error: status === 500 ? 'Internal server error' : error.message }); else res.end(); }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000; server.maxHeadersCount = 50;
  server.on('close', () => db.close());
  return { server, db };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server } = createHub({ database: process.env.FLUXSCALE_HUB_DATABASE, origin: process.env.FLUXSCALE_HUB_ORIGIN, dashboard: process.env.FLUXSCALE_HUB_DASHBOARD });
  server.listen(Number(process.env.PORT ?? 8090), process.env.HOST ?? '127.0.0.1', () => console.log('FluxScale connected hub listening; credentials are not logged'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close());
}
