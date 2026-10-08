import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

const [url, seconds = '40', delay = '1500'] = process.argv.slice(2);
assert(url && Number(seconds) > 0 && Number(seconds) <= 120);
const deadline = performance.now() + Number(seconds) * 1000;
const identities = new Set();
const latencies = [];
let failed = 0;
await Promise.all(Array.from({ length: 8 }, async () => {
  while (performance.now() < deadline) {
    const start = performance.now();
    try {
      const response = await fetch(`${url}/api/checkout?delay=${delay}`, { signal: AbortSignal.timeout(10_000) });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(typeof body.instance_id, 'string');
      identities.add(body.instance_id);
      latencies.push(performance.now() - start);
    } catch {
      failed += 1;
    }
  }
}));
latencies.sort((a, b) => a - b);
console.log(JSON.stringify({ completed: latencies.length, failed, instances: [...identities], p95_ms: latencies[Math.ceil(latencies.length * 0.95) - 1] }));
assert(latencies.length > 0 && failed === 0, 'application load had failures');
