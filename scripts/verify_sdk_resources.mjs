import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), 'fluxscale-quota-'));
const results = [];
await writeFile(join(root, 'check.mjs'), `
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createFluxScale } from '/app/sdk/dist/index.js';
import { readCpuCount, readMemoryLimit } from '/app/sdk/dist/resources.js';
const cpus = Number(process.argv[2]);
const limit = 256 * 1024 ** 2;
assert.equal(Number(readFileSync('/sys/fs/cgroup/memory.max', 'utf8')), limit);
assert.equal(readCpuCount(), cpus);
assert.equal(readMemoryLimit(), limit);
const samples = [];
const server = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  samples.push(JSON.parse(body));
  response.writeHead(202, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ accepted: true, decision: { action: 'hold', desired_replicas: 1 } }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const sdk = createFluxScale({ service: 'quota-check', endpoint: 'http://127.0.0.1:' + server.address().port, flushIntervalMs: 60_000 });
try {
  assert.equal((await sdk.flush()).accepted, true);
  const baselineMemory = samples.at(-1).memory_percent;
  const allocation = Buffer.alloc(64 * 1024 ** 2, 1);
  const start = performance.now();
  while (performance.now() - start < 4000) Math.sqrt(performance.now());
  assert.equal((await sdk.flush()).accepted, true);
  const sample = samples.at(-1);
  const expectedCpu = Math.min(100, 100 / cpus);
  assert(sample.cpu_percent >= expectedCpu * 0.8 && sample.cpu_percent <= expectedCpu * 1.2,
    'Busy single thread must reflect its CPU quota: ' + sample.cpu_percent);
  assert(sample.memory_percent - baselineMemory >= 20, 'Touched 64 MiB should add about 25 percentage points of a 256 MiB limit.');
  const rssPercent = process.memoryUsage().rss / limit * 100;
  assert(Math.abs(sample.memory_percent - rssPercent) <= 2, 'RSS must be normalized to the container memory limit.');
  assert.equal(allocation[allocation.length - 1], 1);
  console.log(JSON.stringify({ cpus, memory_limit_bytes: limit, cpu_percent: sample.cpu_percent,
    memory_percent: sample.memory_percent, baseline_memory_percent: baselineMemory, rss_percent: rssPercent }));
} finally {
  await sdk.close();
  await new Promise(resolve => server.close(resolve));
}
`);

for (const cpus of [0.5, 2]) {
  const name = `fluxscale-quota-check-${randomUUID()}`;
  try {
    const { stdout } = await exec('docker', ['run', '--rm', '--name', name, '--network', 'none',
      '--cpus', String(cpus), '--memory', '256m', '-v', `${root}:/verification:ro`,
      '--entrypoint', 'node', 'fluxscale/express-demo:v1', '/verification/check.mjs', String(cpus)],
    { windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 });
    const result = JSON.parse(stdout.trim());
    assert.equal(result.cpus, cpus);
    results.push(result);
    console.log(`[PASS] ${cpus} CPU / 256 MiB: busy CPU ${result.cpu_percent.toFixed(1)}%, RSS ${result.memory_percent.toFixed(1)}%`);
  } finally {
    // Only this unique test name; timed-out Docker clients may leave their container running.
    await exec('docker', ['rm', '-f', name], { windowsHide: true, timeout: 10_000 }).catch(() => {});
  }
}
await writeFile(join(root, 'result.json'), JSON.stringify(results, null, 2));
console.log(`PASS: Real SDK quota accounting. Evidence: ${root}`);
