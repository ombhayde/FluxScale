import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
const name=`fluxscale-db-check-${randomUUID().slice(0,8)}`;
const database=name+'-database'; const applications=[name+'-a',name+'-b'];
const env={...process.env,POSTGRES_PASSWORD:randomBytes(32).toString('base64url')};
env.FLUXSCALE_DEMO_DATABASE_URL=`postgresql://fluxscale:${env.POSTGRES_PASSWORD}@${database}:5432/fluxscale`;
const exec=promisify(execFile);
const docker=async args=>(await exec('docker',args,{env,windowsHide:true,timeout:60000,maxBuffer:1024*1024})).stdout;
try {
  await docker(['network','create',name]);
  await docker(['run','-d','--name',database,'--network',name,'--memory','512m','--cpus','1','--env','POSTGRES_PASSWORD','--env','POSTGRES_USER=fluxscale','--env','POSTGRES_DB=fluxscale','postgres:18-alpine']);
  let ready=false;for(let i=0;i<60;i++){try{await docker(['exec',database,'pg_isready','-U','fluxscale']);ready=true;break;}catch{await new Promise(r=>setTimeout(r,500));}}assert(ready,'PostgreSQL ready');
  await docker(['cp',join(root,'sdk/node/examples/express/seed.sql'),database+':/tmp/seed.sql']);
  await docker(['exec',database,'psql','-U','fluxscale','-d','fluxscale','-v','ON_ERROR_STOP=1','-f','/tmp/seed.sql']);
  const urls=[];
  for(const app of applications){
    await docker(['run','-d','--name',app,'--network',name,'--memory','256m','--cpus','1','-p','127.0.0.1::3000','--env','FLUXSCALE_DEMO_DATABASE_URL','--env','FLUXSCALE_REQUIRE_AUTH=false','--env','FLUXSCALE_EXECUTION_MODE=observe_only','--env',`FLUXSCALE_INSTANCE_ID=${app}`,'fluxscale/express-demo:v1']);
    const port=JSON.parse(await docker(['inspect','--format','{{json .NetworkSettings.Ports}}',app]))['3000/tcp'][0].HostPort;const url=`http://127.0.0.1:${port}`;urls.push(url);
    let healthy=false;for(let i=0;i<60;i++){try{healthy=(await fetch(url+'/health')).ok;if(healthy)break;}catch{}await new Promise(r=>setTimeout(r,250));}assert(healthy);
  }
  async function operation(url,path,method='GET'){const r=await fetch(url+path,{method,signal:AbortSignal.timeout(10000)});assert.equal(r.status,200);const data=await r.json();assert.equal(data.ok,true);return data;}
  assert.equal((await operation(urls[0],'/api/db/read')).rows,20);
  assert((await operation(urls[0],'/api/db/join')).rows>0);
  assert.equal((await operation(urls[0],'/api/db/write','POST')).value,1);
  assert.equal((await operation(urls[1],'/api/db/write','POST')).value,2);
  assert((await operation(urls[0],'/api/cpu?duration=5')).checksum>0);
  await docker(['rm','-f',applications[0]]);
  assert.equal((await operation(urls[1],'/api/db/write','POST')).value,3);
  const value=await docker(['exec',database,'psql','-U','fluxscale','-d','fluxscale','-Atc','SELECT value FROM benchmark_counters WHERE id=1']);assert.equal(value.trim(),'3');
  console.log('PASS: Real PostgreSQL reads, writes and five-table joins; shared writes survive application replica removal; CPU endpoint computes.');
} finally {
  for(const container of [...applications,database])await docker(['rm','-f',container]).catch(()=>{});
  await docker(['network','rm',name]).catch(()=>{});
}
