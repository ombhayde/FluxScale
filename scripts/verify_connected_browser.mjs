import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHub } from '../connected/server.mjs';
import { token, digest } from '../connected/store.mjs';
const project = fileURLToPath(new URL('../', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'fluxscale-connected-browser-'));
const reservation = createServer(); reservation.listen(0, '127.0.0.1'); await once(reservation, 'listening'); const port = reservation.address().port; reservation.close(); await once(reservation, 'close');
const url = `http://127.0.0.1:${port}`; const hub = createHub({ origin: url, database: join(root, 'hub.sqlite'), dashboard: join(project, 'dashboard-react/dist') });
const invite = token(); const password = token(); hub.db.prepare('INSERT INTO invites VALUES(?,?,?)').run(digest(invite), 'browser@test.dev', Date.now() + 60000);
let browser; let socket; let browserSession; let serial = 0; const pending = new Map(); const exceptions = [];
async function poll(check, label) { const end = Date.now() + 25000; while (Date.now() < end) { try { if (await check()) return; } catch {} await new Promise(resolve => setTimeout(resolve, 200)); } throw Error(`Timed out: ${label}`); }
function command(method, params = {}, sessionId) { return new Promise((resolve, reject) => { const id = ++serial; const timeout = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 10000); pending.set(id, { resolve, reject, timeout }); socket.send(JSON.stringify({ id, method, params, sessionId })); }); }
try {
  hub.server.listen(port, '127.0.0.1'); await once(hub.server, 'listening');
  const profile = join(root, 'browser'); browser = spawn(process.env.FLUXSCALE_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', 'about:blank'], { windowsHide: true, stdio: 'ignore' }); browser.on('error', () => {});
  let endpoint; await poll(async () => { const lines = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n'); endpoint = `ws://127.0.0.1:${lines[0]}${lines[1]}`; return true; }, 'browser starts');
  socket = new WebSocket(endpoint); await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', event => { const message = JSON.parse(event.data); if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails); const task = pending.get(message.id); if (!task) return; pending.delete(message.id); clearTimeout(task.timeout); if (message.error) task.reject(Error(`Browser rejected ${message.id}`)); else task.resolve(message.result); });
  const { targetId } = await command('Target.createTarget', { url: 'about:blank' }); const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true });
  browserSession = sessionId;
  await command('Target.activateTarget', { targetId });
  const evaluate = async expression => { const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId); if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result?.value; };
  await command('Runtime.enable', {}, sessionId); await command('Page.navigate', { url: url + '/connected' }, sessionId);
  await poll(() => evaluate('!!document.querySelector("input[name=email]")'), 'login form');
  await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent.includes("Have an invitation")).click()');
  async function type(selector, value) { await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`); await command('Input.insertText', { text: value }, sessionId); }
  await type('input[name=email]', 'browser@test.dev'); await type('input[name=password]', password); await type('input[name=invite]', invite); await evaluate('document.querySelector("form").requestSubmit()');
  await poll(() => evaluate('document.body.innerText.includes("Your deployments")'), 'account registration');
  await evaluate('document.querySelector("details").open=true'); await type('input[name=name]', 'My production API'); await type('input[name=service]', 'orders');
  await evaluate('document.querySelector("input[name=name]").closest("form").requestSubmit()');
  await poll(() => evaluate('document.body.innerText.includes("Autoscaling paused")'), 'new project starts paused');
  await evaluate('document.querySelector("input[name=enabled]").closest("details").open=true');
  await poll(() => evaluate('[...document.querySelectorAll("button")].some(b=>b.textContent.includes("Generate host enrollment") && !b.disabled)'), 'enrollment button enabled');
  await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent.includes("Generate host enrollment")).click()');
  await poll(() => evaluate('document.querySelector("input[aria-label]")?.value.length===43'), 'enrollment displayed');
  await poll(() => evaluate('[...document.querySelectorAll("button")].some(b=>b.textContent.includes("Save policy") && !b.disabled)'), 'policy button enabled');
  await evaluate('document.querySelector("input[name=enabled]").click(); document.querySelector("input[name=enabled]").closest("form").requestSubmit()');
  await poll(() => evaluate('document.body.innerText.includes("Autoscaling enabled") && document.body.innerText.includes("Policy v2")'), 'policy saved');
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, sessionId);
  assert(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'), 'Connected mobile screen overflows');
  await evaluate('document.querySelector(".connected-project").click()');
  assert.equal(await evaluate('!!document.querySelector("input[aria-label]")'), false);
  if (process.env.FLUXSCALE_CONNECTED_SCREENSHOT) { await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId); const shot = await command('Page.captureScreenshot', { format: 'png' }, sessionId); await writeFile(process.env.FLUXSCALE_CONNECTED_SCREENSHOT, Buffer.from(shot.data, 'base64')); }
  await poll(() => evaluate('[...document.querySelectorAll("button")].some(b=>b.textContent.includes("Sign out") && !b.disabled)'), 'sign-out button enabled');
  await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent.includes("Sign out")).click()');
  await poll(() => evaluate('!!document.querySelector("input[name=email]") && !document.body.innerText.includes("My production API")'), 'sign-out clears project data');
  await type('input[name=email]', 'browser@test.dev'); await type('input[name=password]', password); await evaluate('document.querySelector("form").requestSubmit()');
  await poll(() => evaluate('document.body.innerText.includes("My production API")'), 'existing account signs in');
  hub.db.prepare('DELETE FROM sessions').run();
  await poll(() => evaluate('!!document.querySelector("input[name=email]") && !document.body.innerText.includes("My production API")'), 'revoked session clears customer data');
  assert.equal(exceptions.length, 0, JSON.stringify(exceptions)); console.log(`PASS: Connected account, project, enrollment, policy, mobile, sign-out and session revocation. Evidence: ${root}`);
} catch (error) {
  if (socket?.readyState === WebSocket.OPEN && browserSession) {
    const result = await command('Runtime.evaluate', { expression: 'document.body.innerText', returnByValue: true }, browserSession).catch(() => null);
    if (result) await writeFile(join(root, 'failure.txt'), String(result.result?.value));
    console.error(`Browser failure evidence: ${root}`);
  }
  throw error;
} finally {
  if (socket?.readyState === WebSocket.OPEN) { try { await command('Browser.close'); } catch {} } socket?.close(); for (const task of pending.values()) clearTimeout(task.timeout); browser?.kill(); hub.server.close(); await once(hub.server, 'close');
}
