import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { runPhase, runRatePhase } from '../../scripts/demo_load.mjs';
test('demo counts exactly attempted requests without retrying failures', async t => {
  let requests = 0; const server = createServer((_req,res) => { requests++; res.writeHead(requests === 7 ? 503 : 200, { 'Content-Type':'application/json' }); res.end(JSON.stringify({ instance_id: 'real-test-instance' })); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(async () => { server.close(); await once(server,'close'); });
  const result = await runPhase({ url:`http://127.0.0.1:${server.address().port}`, requests:31, concurrency:5, delay:20 });
  assert.equal(requests,31); assert.equal(result.attempted,31); assert.equal(result.successful,30); assert.equal(result.failed,1); assert.equal(result.instances['real-test-instance'],30);
  await assert.rejects(runPhase({ url:'https://example.com',requests:1,concurrency:1,delay:20 }));
});

test('mixed rate load uses POST for writes and reports unsent demand separately', async t => {
  let received=0,writes=0;const server=createServer((req,res)=>{received++;const workload=req.url.startsWith('/api/cpu')?'cpu':req.url.split('/')[3].split('?')[0];if(workload==='write'){assert.equal(req.method,'POST');writes++;}setTimeout(()=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({instance_id:'fixture',workload}));},30);});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{server.close();await once(server,'close');});
  const result=await runRatePhase({url:`http://127.0.0.1:${server.address().port}`,target_rps:1000,duration_seconds:.3,concurrency:8,workloads:true});
  assert.equal(result.scheduled_requests,300);assert.equal(result.attempted+result.dropped_before_send,300);assert(result.dropped_before_send>0);assert.equal(result.failed,0);assert.equal(received,result.attempted);assert.equal(result.workloads.write.attempted,writes);assert.equal(Object.keys(result.workloads).length,4);
});
