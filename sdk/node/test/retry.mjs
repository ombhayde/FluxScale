import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createFluxScale } from '../dist/index.js';

for (const status of [429, 503, 422, 401]) {
  test(`HTTP ${status} ${status >= 500 || status === 429 ? 'retries' : 'discards'} the original window`, async () => {
    const samples = [];
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      samples.push(JSON.parse(body));
      response.writeHead(samples.length === 1 ? status : 202, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(samples.length === 1 ? { error: 'test' } : {
        accepted: true, decision: { action: 'hold', desired_replicas: 1 },
      }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const sdk = createFluxScale({ service: 'retry-test', endpoint: `http://127.0.0.1:${server.address().port}`, flushIntervalMs: 60_000 });
    try {
      assert.equal(await sdk.flush(), null);
      await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal((await sdk.flush()).accepted, true);
      if (status === 429 || status >= 500) assert.deepEqual(samples[0], samples[1]);
      else assert.notEqual(samples[0].timestamp, samples[1].timestamp);
    } finally {
      await sdk.close();
      await new Promise(resolve => server.close(resolve));
    }
  });
}
