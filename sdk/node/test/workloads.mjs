import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createFluxScale } from '../dist/index.js';

test('workload telemetry counts completed reads/writes, failures and idle windows without double counting', async () => {
  let received;
  const ingest = createServer(async (req, res) => { let body=''; for await(const chunk of req) body+=chunk; received=JSON.parse(body); res.setHeader('Content-Type','application/json');res.end(JSON.stringify({accepted:true})); });
  ingest.listen(0,'127.0.0.1');await once(ingest,'listening');
  const sdk=createFluxScale({service:'workloads',endpoint:`http://127.0.0.1:${ingest.address().port}`,flushIntervalMs:3600000,workloadLabel:req=>req.path.slice(1)});
  const app=express();app.use(sdk.middleware);app.get('/read',(_req,res)=>res.json({ok:true}));app.post('/write',(req,res)=>res.status(req.query.fail?503:200).json({ok:!req.query.fail}));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
  try {
    for(const path of ['/read','/read','/read','/write','/write?fail=1']) await (await fetch(base+path,{method:path.startsWith('/write')?'POST':'GET'})).text();
    await sdk.flush();
    const rows=Object.fromEntries(received.workloads.map(w=>[w.name,w]));
    assert.equal(rows.read.completed_requests,3);assert.equal(rows.read.failed_requests,0);
    assert.equal(rows.write.completed_requests,2);assert.equal(rows.write.failed_requests,1);
    assert(rows.read.requests_per_second>0);assert(rows.read.p95_latency_ms>=0);
    await sdk.flush();assert(received.workloads.every(w=>w.completed_requests===0&&w.failed_requests===0&&w.requests_per_second===0));
  } finally { await sdk.close();server.close();ingest.close();await Promise.all([once(server,'close'),once(ingest,'close')]); }
});
