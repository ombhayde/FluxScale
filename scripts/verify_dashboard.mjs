import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const temporaryRoot = await mkdtemp(join(tmpdir(), 'fluxscale-browser-'));
let readToken = randomBytes(32).toString('hex');
const ingestToken = randomBytes(32).toString('hex');
const managedToken = randomBytes(32).toString('hex');
let controller;
let browser;
let socket;
let commandId = 0;
const pending = new Map();

async function poll(check, description, timeout = 25_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch { }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out: ${description}`);
}
function command(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++commandId;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Browser command timed out: ${method}`)); }, 10_000);
    pending.set(id, { resolve, reject, timeout });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
}
async function ports() {
  const listeners = [createServer(), createServer()];
  try {
    await Promise.all(listeners.map(server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve))));
    return listeners.map(server => server.address().port);
  } finally {
    await Promise.all(listeners.map(server => new Promise(resolve => server.close(resolve))));
  }
}
try {
  const [controlPort, proxyPort] = await ports();
  const url = `http://127.0.0.1:${controlPort}`;
  const configPath = join(temporaryRoot, 'controller.toml');
  await writeFile(configPath, `[server]\nbind="127.0.0.1:${controlPort}"\ndashboard_path=${JSON.stringify(join(project, 'dashboard-react/dist').replaceAll('\\', '/'))}\n[proxy]\nbind="127.0.0.1:${proxyPort}"\n[security]\nenabled=true\n[docker]\nenabled=false\n`);
  controller = spawn(join(process.env.CARGO_TARGET_DIR ?? join(process.env.LOCALAPPDATA, 'FluxScale/target'), 'debug/fluxscale-core.exe'), [configPath], {
    cwd: project, windowsHide: true, stdio: 'ignore', env: { ...process.env, FLUXSCALE_STATE_PATH: join(temporaryRoot, 'state.json'), FLUXSCALE_READ_TOKEN: readToken, FLUXSCALE_INGEST_TOKEN: ingestToken, FLUXSCALE_MANAGED_TOKEN: managedToken },
  });
  controller.on('error', () => { });
  await poll(async () => (await fetch(`${url}/api/v1/observability/ready`)).status === 200, 'isolated controller startup');
  const profile = join(temporaryRoot, 'edge-profile');
  browser = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  browser.on('error', () => { });
  let debuggingPort;
  let endpoint;
  await poll(async () => {
    const lines = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
    debuggingPort = lines[0];
    endpoint = `ws://127.0.0.1:${debuggingPort}${lines[1]}`;
    return endpoint;
  }, 'headless Edge startup');
  socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    clearTimeout(task.timeout);
    if (message.error) task.reject(new Error('Browser rejected a command.'));
    else task.resolve(message.result);
  });
  const { targetId } = await command('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await command('Target.attachToTarget', { targetId, flatten: true });
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
    if (result.exceptionDetails) throw new Error('Dashboard browser evaluation failed.');
    return result.result?.value;
  };
  await command('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, sessionId);
  await command('Page.navigate', { url }, sessionId);
  await poll(() => evaluate('Boolean(document.querySelector("#fluxscale-read-token"))'), 'read-token login form');
  await evaluate('document.querySelector("#fluxscale-read-token").focus()');
  await command('Input.insertText', { text: readToken }, sessionId);
  await command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r', unmodifiedText: '\r' }, sessionId);
  await command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }, sessionId);
  await poll(() => evaluate('document.body.innerText.includes("Waiting for traffic samples.")'), 'authenticated empty dashboard');
  assert.equal(await evaluate('document.documentElement.classList.contains("dark")'), false);
  assert.equal(await evaluate('document.querySelector(".console-release").textContent'), '0.5.0-rc.1');
  assert.equal(await evaluate('document.body.innerText.includes("Updating forecast")'), false);
  console.log('[PASS] Real browser login, light theme and empty dashboard without an endless chart spinner');

  const response = await fetch(`${url}/api/v1/metrics`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ingestToken}`, 'X-FluxScale-Execution-Mode': 'observe_only' }, body: JSON.stringify({ service: 'browser-demo', instance_id: 'browser-instance', timestamp: new Date().toISOString(), requests_per_second: 10, active_requests: 0, p95_latency_ms: 50, error_rate: 0, cpu_percent: 10, memory_percent: 10, current_replicas: 1 }) });
  assert.equal(response.status, 202);
  await poll(() => evaluate('document.body.innerText.includes("browser-demo") && document.querySelector(".console-capacity-meter").innerText.includes("Learning")'), 'service data and unknown capacity');
  if (process.env.FLUXSCALE_SCREENSHOT_PATH) {
    await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
    const screenshot = await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId);
    await writeFile(process.env.FLUXSCALE_SCREENSHOT_PATH, Buffer.from(screenshot.data, 'base64'));
  }
  await evaluate('[...document.querySelectorAll("[role=tab]")].find(tab => tab.innerText.includes("Operations")).click()');
  await poll(() => evaluate('document.querySelectorAll(".console-workbench tbody tr").length > 0'), 'operations audit capability after release bump');
  await evaluate('[...document.querySelectorAll("[role=tab]")].find(tab => tab.innerText.includes("Fleet")).click()');
  await poll(() => evaluate('document.body.innerText.includes("browser-instance")'), 'fleet instance table');
  await poll(() => evaluate('document.querySelector(".console-workbench").innerText.includes("Stale")'), 'stopped telemetry displayed as stale');
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, sessionId);
  assert(await evaluate('document.documentElement.scrollWidth <= window.innerWidth + 1'), 'Mobile viewport overflows horizontally.');
  console.log('[PASS] Service selection, unknown capacity, operations tab, stale telemetry and mobile width');
  await evaluate('[...document.querySelectorAll("button")].find(button => button.textContent.includes("Lock dashboard")).click()');
  await poll(() => evaluate('Boolean(document.querySelector("#fluxscale-read-token"))'), 'dashboard lock clears access');
  await evaluate('document.querySelector("#fluxscale-read-token").focus()');
  await command('Input.insertText', { text: readToken }, sessionId);
  await evaluate('document.querySelector("form").requestSubmit()');
  await poll(() => evaluate('!document.querySelector("#fluxscale-read-token")'), 'dashboard can unlock again');
  controller.kill();
  await poll(() => controller.exitCode !== null || controller.signalCode !== null, 'test controller stops for token rotation');
  readToken = randomBytes(32).toString('hex');
  controller = spawn(join(process.env.CARGO_TARGET_DIR ?? join(process.env.LOCALAPPDATA, 'FluxScale/target'), 'debug/fluxscale-core.exe'), [configPath], {
    cwd: project, windowsHide: true, stdio: 'ignore', env: { ...process.env, FLUXSCALE_STATE_PATH: join(temporaryRoot, 'state.json'), FLUXSCALE_READ_TOKEN: readToken, FLUXSCALE_INGEST_TOKEN: ingestToken, FLUXSCALE_MANAGED_TOKEN: managedToken },
  });
  controller.on('error', () => { });
  await poll(() => evaluate('Boolean(document.querySelector("#fluxscale-read-token"))'), 'expired credentials return to the login form');
  console.log('[PASS] Keyboard login, lock/unlock and expired-token recovery');
  console.log('PASS: Dashboard browser interaction verification completed.');
} finally {
  if (socket?.readyState === WebSocket.OPEN) { try { await command('Browser.close'); } catch { } }
  socket?.close();
  for (const task of pending.values()) clearTimeout(task.timeout);
  controller?.kill();
  browser?.kill();
  await new Promise(resolve => setTimeout(resolve, 1000));
  const root = resolve(temporaryRoot);
  assert(root.startsWith(resolve(tmpdir()) + sep) && basename(root).startsWith('fluxscale-browser-'), 'Unsafe browser cleanup path.');
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
