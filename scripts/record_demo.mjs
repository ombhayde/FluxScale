import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHub } from '../connected/server.mjs';
import { token, digest } from '../connected/store.mjs';
import { enroll, cycle } from '../connected/agent.mjs';
import { runPhase, runRatePhase } from './demo_load.mjs';
import { openDemoBrowser } from './demo_browser.mjs';
const project = fileURLToPath(new URL('../', import.meta.url));
const output = join(project,'artifacts/demo'); await mkdir(output,{recursive:true});
const root = await mkdtemp(join(tmpdir(),'fluxscale-recorded-demo-')); const id=randomUUID().slice(0,8); const exec=promisify(execFile);
const ffmpeg=process.env.FLUXSCALE_FFMPEG ?? join(process.env.LOCALAPPDATA??'','FluxScale/video-tools/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe');
const deployments=[]; let hub; let browser; let workers; let stopping=false; let video; const samples=[]; const phases=[]; let baselineRequests=0;
let stage='Preparing real deployments'; let attempted=0; let successful=0; let failed=0;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function freePorts(){const servers=Array.from({length:5},()=>createServer());await Promise.all(servers.map(s=>new Promise(resolve=>s.listen(0,'127.0.0.1',resolve))));const ports=servers.map(s=>s.address().port);await Promise.all(servers.map(s=>new Promise(resolve=>s.close(resolve))));return ports;}
async function poll(check,label,timeout=90000){const end=Date.now()+timeout;while(Date.now()<end){try{if(await check()){console.log(`[PASS] ${label}`);return;}}catch{}await sleep(500);}throw Error(`Timed out: ${label}`);}
async function docker(args,env=process.env){return exec('docker',args,{env,windowsHide:true,timeout:60000,maxBuffer:1024*1024});}
async function local(deployment,path,options={}){const response=await fetch(deployment.control+path,{...options,headers:{Authorization:`Bearer ${deployment.readToken}`,...options.headers},signal:AbortSignal.timeout(10000)});assert(response.ok,`Local API ${response.status}`);return response.json();}
async function topology(d,count){const {backends}=await local(d,`/api/v1/backends/${d.service}`);return backends.length===count&&backends.every(b=>b.healthy&&!b.draining);}
async function hubCall(path,identity,method='GET',data){const response=await fetch(hub.origin+path,{method,headers:{Origin:hub.origin,'Content-Type':'application/json',...(identity?{Cookie:identity.cookie,'X-CSRF-Token':identity.csrf}:{})},body:data===undefined?undefined:JSON.stringify(data),signal:AbortSignal.timeout(10000)});assert(response.ok,`Hub request ${response.status}`);return{data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};}
async function account(email,name,service,max){const invite=token();hub.db.prepare('INSERT INTO invites VALUES(?,?,?)').run(digest(invite),email,Date.now()+60000);const password=token();const registered=await hubCall('/api/auth/register',null,'POST',{email,password,invite});const identity={email,password,cookie:registered.cookie,csrf:registered.data.csrf};const p=(await hubCall('/api/projects',identity,'POST',{name,service,policy:{enabled:true,min_replicas:1,max_replicas:max}})).data;return{...identity,projectId:p.id};}
async function caption(){if(!browser)return;await browser.evaluate(`(()=>{let panel=document.getElementById('demo-measurements');if(!panel){panel=document.createElement('div');panel.id='demo-measurements';panel.style.cssText='position:fixed;right:22px;bottom:20px;z-index:9999;background:#122f3d;color:white;border-radius:12px;padding:14px 22px;font:16px system-ui;box-shadow:0 6px 24px #0003;max-width:580px';document.body.append(panel)}panel.textContent=${JSON.stringify(`${stage} | ${attempted.toLocaleString('en-IN')} / 1,00,000 requests | ${failed} failures`)}})()`);}
async function login(identity){await browser.navigate(hub.origin+'/connected');await poll(()=>browser.evaluate('!!document.querySelector("input[name=email]")'),'User login form');await browser.type('input[name=email]',identity.email);await browser.type('input[name=password]',identity.password);await browser.evaluate('document.querySelector("form").requestSubmit()');await poll(()=>browser.evaluate(`document.body.textContent.includes(${JSON.stringify(identity.email)}) && document.body.textContent.includes('Your deployments')`),'User signed in');await poll(()=>browser.evaluate('!!document.querySelector("a[data-project-console]")'),'Original dashboard link');await browser.navigate(await browser.evaluate('document.querySelector("a[data-project-console]").href')); await poll(()=>browser.evaluate(`!!document.querySelector('.fluxscale-console') && document.body.textContent.includes(${JSON.stringify(identity.email)})`),'Original FluxScale React dashboard with user-scoped data');await poll(()=>browser.evaluate('[...document.querySelectorAll(".console-metric")].length===4 && [...document.querySelectorAll(".console-metric")].every(e=>Number(getComputedStyle(e).opacity)>0.99)'), 'Original dashboard panels are visibly rendered');}
async function logout(){await browser.navigate(hub.origin+'/connected');await poll(()=>browser.evaluate('[...document.querySelectorAll("button")].some(b=>b.textContent.includes("Sign out")&&!b.disabled)'),'Sign-out available');await browser.evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent.includes("Sign out")).click()');await poll(()=>browser.evaluate('!!document.querySelector("input[name=email]")'),'User signed out');}
try {
  const ports=await freePorts();
  for(const [index,service] of ['store-api','billing-api'].entries()){
    const directory=join(root,service);await mkdir(join(directory,'state'),{recursive:true});
    const ownership=`fluxscale-demo-${id}-${index}`;const readToken=token(),managedToken=token();
    const env={...process.env,FLUXSCALE_READ_TOKEN:readToken,FLUXSCALE_INGEST_TOKEN:token(),FLUXSCALE_MANAGED_TOKEN:managedToken};
    let config=(await readFile(join(project,'deploy/fluxscale.toml'),'utf8')).replace('network = "fluxscale-app"',`network = "${ownership}"`).replace('name_prefix = "fluxscale-deploy"',`name_prefix = "${ownership}"`);
    config=config.replace('port_block_size = 4','port_block_size = 8');config=config.replace('max_replicas = 3',`max_replicas = ${index===0?6:1}`);if(index===0){env.POSTGRES_PASSWORD=token();env.FLUXSCALE_DEMO_DATABASE_URL=`postgresql://fluxscale:${env.POSTGRES_PASSWORD}@${ownership}-database:5432/fluxscale`;config=config.replace('environment = ["FLUXSCALE_MANAGED_TOKEN"]','environment = ["FLUXSCALE_MANAGED_TOKEN", "FLUXSCALE_DEMO_DATABASE_URL"]');}await writeFile(join(directory,'fluxscale.toml'),config);
    let spec=(await readFile(join(project,'deploy/compose.yaml'),'utf8')).replace('context: ..',`context: ${JSON.stringify(project.replaceAll('\\','/'))}`).replace('127.0.0.1:8080:8080',`127.0.0.1:${ports[index*2]}:8080`).replace('127.0.0.1:8081:8081',`127.0.0.1:${ports[index*2+1]}:8081`).replace('- state:/data',`- ${JSON.stringify(join(directory,'state').replaceAll('\\','/')+':/data')}`).replace('name: fluxscale-app',`name: ${ownership}`);
    if(index===0)spec=spec.replace('    environment:', '    environment:\n      FLUXSCALE_DEMO_DATABASE_URL: ${FLUXSCALE_DEMO_DATABASE_URL}');
    const composePath=join(directory,'compose.yaml');await writeFile(composePath,spec);
    const d={service,ownership,env,readToken,managedToken,composePath,control:`http://127.0.0.1:${ports[index*2]}`,proxy:`http://127.0.0.1:${ports[index*2+1]}/${service}`};deployments.push(d);
    await docker(['compose','-f',composePath,'-p',ownership,'up','-d','--no-build'],env);
    if(index===0){d.databaseName=ownership+'-database';await docker(['run','-d','--name',d.databaseName,'--network',ownership,'--memory','512m','--cpus','1','--env','POSTGRES_PASSWORD','--env','POSTGRES_USER=fluxscale','--env','POSTGRES_DB=fluxscale','postgres:18-alpine'],env);await poll(async()=>{await docker(['exec',d.databaseName,'pg_isready','-h','127.0.0.1','-U','fluxscale'],env);return true;},'Shared PostgreSQL ready');await docker(['cp',join(project,'sdk/node/examples/express/seed.sql'),d.databaseName+':/tmp/seed.sql'],env);await docker(['exec',d.databaseName,'psql','-U','fluxscale','-d','fluxscale','-v','ON_ERROR_STOP=1','-f','/tmp/seed.sql'],env);}

    await poll(async()=> (await local(d,'/api/v1/observability/ready')).probe==='ok',`${service}: controller ready`);
    await local(d,'/api/v1/metrics',{method:'POST',headers:{Authorization:`Bearer ${managedToken}`,'Content-Type':'application/json','X-FluxScale-Execution-Mode':'managed'},body:JSON.stringify({service,requests_per_second:0,current_replicas:1})});
    await poll(()=>topology(d,1),`${service}: one actual healthy Docker container`);
  }
  const origin=`http://127.0.0.1:${ports[4]}`;hub={...createHub({database:join(root,'hub.sqlite'),origin,dashboard:join(project,'dashboard-react/dist')}),origin};hub.server.listen(ports[4],'127.0.0.1');await once(hub.server,'listening');
  const alice=await account('alice@demo.fluxscale.dev','Alice / Store API','store-api',6);const bob=await account('bob@demo.fluxscale.dev','Bob / Billing API','billing-api',1);
  for(const [index,owner] of [alice,bob].entries()){const d=deployments[index];const enrollment=(await hubCall(`/api/projects/${owner.projectId}/enrollment`,owner,'POST',{})).data;d.agent=await enroll({hub:origin,controller:d.control,service:d.service},enrollment.token);d.agent=await cycle(d.agent,d);d.agent=await cycle(d.agent,d);assert.equal(d.agent.applied_version,1);}
  assert.deepEqual((await hubCall('/api/projects',alice)).data.map(p=>p.id),[alice.projectId]);assert.deepEqual((await hubCall('/api/projects',bob)).data.map(p=>p.id),[bob.projectId]);
  const forbidden=await fetch(origin+`/api/projects/${alice.projectId}`,{headers:{Cookie:bob.cookie}});assert.equal(forbidden.status,404);console.log('[PASS] Actual user accounts and server-enforced project isolation');
  workers=Promise.all([
    (async()=>{while(!stopping){await Promise.all(deployments.map(async d=>{try{d.agent=await cycle(d.agent,d);}catch(error){d.report_errors=(d.report_errors??0)+1;if(d.report_errors<=10)console.error(`Host report ${d.service}: ${error.message}`);}}));await sleep(4000);}})(),
    (async()=>{while(!stopping){try{const response=await fetch(deployments[1].proxy+'/api/checkout?delay=20',{signal:AbortSignal.timeout(5000)});if(response.ok)baselineRequests++;await response.arrayBuffer();}catch{}await sleep(1000);}})(),
    (async()=>{while(!stopping){try{const d=deployments[0];const [metrics,backends,decisions,overview]=await Promise.all([local(d,`/api/v1/services/${d.service}/metrics`),local(d,`/api/v1/backends/${d.service}`),local(d,'/api/v1/decisions'),local(d,'/api/v1/dashboard/overview')]);samples.push({at:new Date().toISOString(),phase:stage,attempted,successful,failed,healthy_replicas:backends.backends.filter(b=>b.healthy&&!b.draining).length,backend_names:backends.backends.map(b=>b.name),workloads:overview.services.find(v=>v.service===d.service)?.workloads??[],latest:metrics.at(-1),decision:decisions.find(v=>v.service===d.service)});await caption();}catch{}await sleep(2000);}})(),
  ]);
  browser=await openDemoBrowser(root);await browser.navigate(origin+'/demo-architecture.html');await poll(()=>browser.evaluate('document.body.innerText.includes("Predict demand")'),'Architecture slide');await browser.startRecording(join(output,'fluxscale-demo.mp4'),ffmpeg);await sleep(7000);
  stage='Bob: separate project with real baseline traffic';await login(bob);await poll(()=>browser.evaluate('document.body.textContent.includes("Bob / Billing API")'),'Bob sees only his project');assert.equal(await browser.evaluate('document.body.textContent.includes("Alice / Store API")'),false);await caption();await sleep(8000);await browser.screenshot(join(output,'bob-project.png'));await logout();
  stage='Alice: warm-up, one actual replica';await login(alice);await poll(()=>browser.evaluate('document.body.textContent.includes("Alice / Store API")'),'Alice sees only her project');assert.equal(await browser.evaluate('document.body.textContent.includes("Bob / Billing API")'),false);
  async function measured(phase,rate=false){
    stage=phase.name;const before={attempted,successful,failed};await caption();
    const load=(rate?runRatePhase:runPhase)({url:deployments[0].proxy,workloads:true,...phase,onProgress:p=>{attempted=before.attempted+p.attempted;successful=before.successful+p.successful;failed=before.failed+p.failed;}});load.catch(()=>{});
    if(phase.name.startsWith('CPU pressure')){
      await poll(async()=>{const b=(await local(deployments[0],'/api/v1/backends/store-api')).backends;return b.filter(v=>v.healthy&&!v.draining).length>=2;},'Real healthy replicas increase under computational pressure');
      await poll(async()=>{const detail=(await hubCall(`/api/projects/${alice.projectId}`,alice)).data;return detail.host.snapshot.backends.filter(b=>b.healthy&&!b.draining).length>=2;},'User dashboard receives actual scale-out report');
      await sleep(3000);await browser.screenshot(join(output,'scale-out.png'));
      for(const view of ['Fleet','Workloads','Capacity']){await browser.evaluate(`[...document.querySelectorAll('.console-rail__nav-item')].find(b=>b.textContent.includes(${JSON.stringify(view)})).click()`);await sleep(4000);await browser.screenshot(join(output,view.toLowerCase()+'.png'));if(view==='Workloads')assert.equal(await browser.evaluate("['cpu','read','write','join'].every(name=>document.body.textContent.includes(name))"),true);}
      await browser.evaluate("[...document.querySelectorAll('.console-rail__nav-item')].find(b=>b.textContent.includes('Overview')).click()");
    }
    const result=await load;phases.push({name:phase.name,...result});await writeFile(join(output,'phase-results.json'),JSON.stringify(phases,null,2));
    console.log(`[MEASURED] ${phase.name}: ${result.successful}/${result.attempted} succeeded, ${result.successful_rps.toFixed(1)} RPS, P95 ${result.p95_ms?.toFixed(2)} ms${rate?`, ${result.dropped_before_send} scheduled requests not sent`:''}`);
  }
  await measured({name:'Mixed workload warm-up',requests:1000,concurrency:8,cpu_ms:5});
  await measured({name:'CPU pressure with real reads, writes and joins',requests:10000,concurrency:64,cpu_ms:40});
  for(const target of [50,300,1000,10000,100000,50])await measured({name:`Mixed offered-rate target: ${target.toLocaleString('en-IN')} RPS`,target_rps:target,duration_seconds:5,concurrency:128,cpu_ms:5,max_requests:100000-attempted},true);
  await measured({name:'Mixed traffic burst: remaining client requests',requests:100000-attempted,concurrency:64,cpu_ms:5});
  stage='Traffic stopped: watch safe scale-in';await caption();await poll(()=>topology(deployments[0],1),'Scale-in returns to one actual healthy replica');await sleep(8000);await browser.screenshot(join(output,'scale-in.png'));
  assert.equal(attempted,100000);assert.equal(successful+failed,100000);assert(samples.some(s=>s.healthy_replicas>=2));assert.equal(samples.at(-1).healthy_replicas,1);
  const inspect=await docker(['ps','--filter',`name=${deployments[0].ownership}`,'--format','{{.Names}}']);assert(inspect.stdout.split('\n').some(name=>name.startsWith(deployments[0].ownership+'-')));
  const committed=Number((await docker(['exec',deployments[0].databaseName,'psql','-U','fluxscale','-d','fluxscale','-Atc','SELECT SUM(value) FROM benchmark_counters'],deployments[0].env)).stdout.trim());const writes=phases.reduce((sum,p)=>sum+(p.workloads.write?.successful??0),0);const writeAttempts=phases.reduce((sum,p)=>sum+(p.workloads.write?.attempted??0),0);assert(committed>=writes&&committed<=writeAttempts,'Shared database commits agree with acknowledged/non-replayed write attempts');
  stage=`Measured: ${successful.toLocaleString('en-IN')} successes · ${failed} failures · real scale-in verified`;await caption();await sleep(8000);video=await browser.stopRecording();
  const report={run_at:new Date().toISOString(),scope:'Two isolated local Docker deployments with distinct user accounts. Primary workload counts application requests only; baseline traffic is separate.',total_attempted:attempted,total_successful:successful,total_failed:failed,phases,baseline_requests:baselineRequests,replica_milestones:[1,Math.max(...samples.map(s=>s.healthy_replicas)),1],replica_sequence:samples.map(s=>s.healthy_replicas).filter((n,i,a)=>i===0||n!==a[i-1]),database_writes_committed:committed,acknowledged_database_writes:writes,host_maximum_replicas:6,maximum_observed_replicas:Math.max(...samples.map(s=>s.healthy_replicas)),user_project_isolation:'verified server-side and in browser',video,limitations:['Controlled local test, not cloud production validation','Controlled benchmark database and bounded CPU loops; not production data','Offered rate targets are not achieved throughput; generator drops unsent demand when concurrency is exhausted','100000 total requests, not 100000 requests per second','No cloud VM provisioning or HA claim']};
  await writeFile(join(output,'result.json'),JSON.stringify(report,null,2));await writeFile(join(output,'timeline.json'),JSON.stringify(samples,null,2));console.log(`PASS: Recorded actual 100,000-request demo. Video and evidence: ${output}`);
} finally {
  stopping=true;if(workers)await workers;await browser?.close();if(hub){hub.server.close();await once(hub.server,'close');}
  for(const d of deployments){const args=['compose','-f',d.composePath,'-p',d.ownership];const logs=await docker([...args,'logs','--no-color'],d.env).catch(()=>null);if(logs)await writeFile(join(root,`${d.service}.log`),logs.stdout);await docker([...args,'stop','controller'],d.env).catch(()=>{});const owned=await docker(['ps','-a','--filter','label=fluxscale.managed=true','--format','{{.Names}}'],d.env).catch(()=>null);for(const name of owned?.stdout.split('\n').filter(n=>n.startsWith(d.ownership+'-'))??[])await docker(['rm','-f',name],d.env);if(d.databaseName)await docker(['rm','-f',d.databaseName],d.env).catch(()=>{});await docker([...args,'down'],d.env).catch(()=>{});}
  console.log(`Private runtime evidence retained at ${root}; it is excluded from the shareable package.`);
}
