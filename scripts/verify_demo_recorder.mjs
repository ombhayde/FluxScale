import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openDemoBrowser } from './demo_browser.mjs';

const root = await mkdtemp(join(tmpdir(), 'fluxscale-recorder-check-'));
const ffmpeg = process.env.FLUXSCALE_FFMPEG ?? join(process.env.LOCALAPPDATA ?? '', 'FluxScale/video-tools/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe');
const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(`<h1>Recorder navigation fixture: ${req.url}</h1>`); });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
let browser;
try {
  browser = await openDemoBrowser(root);
  const origin = `http://127.0.0.1:${server.address().port}`;
  await browser.navigate(origin + '/start');
  const video = join(root, 'navigation.mp4');
  await browser.startRecording(video, ffmpeg);
  for (let i = 0; i < 10; i++) {
    await browser.navigate(`${origin}/page-${i}`);
    assert.equal(await browser.evaluate('document.visibilityState'), 'visible');
    assert((await browser.evaluate('document.body.textContent')).includes(`page-${i}`));
    await new Promise(resolve => setTimeout(resolve, 600));
    await browser.screenshot(join(root, 'last-page.png'));
  }
  const result = await browser.stopRecording();
  assert(result.frames >= 10, 'Recording must continue across navigation and manual screenshots');
  await promisify(execFile)(ffmpeg, ['-v', 'error', '-i', video, '-f', 'null', process.platform === 'win32' ? 'NUL' : '/dev/null'], { windowsHide: true, timeout: 30000 });
  console.log(`PASS: ${result.frames} browser frames across ten navigations; MP4 fully decodes. Evidence: ${root}`);
} finally {
  await browser?.close(); server.close(); await once(server, 'close');
}
