import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
const mix=['read','read','read','read','read','read','read','write','write','write','write','write','join','join','join','join','cpu','cpu','cpu','cpu'];
function collector(options) {
  const {url,concurrency,cpu_ms=5,delay=20,workloads=false,onProgress=()=>{}}=options;
  const target=new URL(url);
  assert(['127.0.0.1','localhost','[::1]'].includes(target.hostname),'Demo load is restricted to the local deployment');
  assert(Number.isInteger(concurrency)&&concurrency>=1&&concurrency<=128);
  assert(Number.isInteger(delay)&&delay>=20&&delay<=2000);
  assert(Number.isInteger(cpu_ms)&&cpu_ms>=5&&cpu_ms<=50);
  let successful=0,failed=0;const durations=[],instances={},statuses={},errors=[],groups={};const started=performance.now();
  async function request(index) {
    const name=workloads?mix[index%mix.length]:'checkout';
    const path=name==='cpu'?`/api/cpu?duration=${cpu_ms}`:name==='checkout'?`/api/checkout?delay=${delay}`:`/api/db/${name}?id=${index%900+1}`;
    const group=groups[name]??={attempted:0,successful:0,failed:0,durations:[]};group.attempted++;
    const start=performance.now();
    try {
      const response=await fetch(url+path,{method:name==='write'?'POST':'GET',signal:AbortSignal.timeout(15000)});
      statuses[response.status]=(statuses[response.status]??0)+1;
      const body=await response.json();assert.equal(response.status,200);assert.equal(typeof body.instance_id,'string');
      if(workloads)assert.equal(body.workload??body.route,name);
      instances[body.instance_id]=(instances[body.instance_id]??0)+1;successful++;group.successful++;
      const duration=performance.now()-start;durations.push(duration);group.durations.push(duration);
    } catch(error) {failed++;group.failed++;if(errors.length<100)errors.push({request_index:index,workload:name,elapsed_ms:performance.now()-start,error:error.name,cause:error.cause?.code??null});}
    onProgress({attempted:successful+failed,successful,failed});
  }
  function finish(extra={}) {
    const seconds=(performance.now()-started)/1000;durations.sort((a,b)=>a-b);
    const percentile=(values,p)=>values[Math.ceil(values.length*p)-1]??null;
    return {attempted:successful+failed,successful,failed,concurrency,configured_delay_ms:workloads?null:delay,cpu_ms:workloads?cpu_ms:null,elapsed_seconds:seconds,successful_rps:successful/seconds,p50_ms:percentile(durations,.5),p95_ms:percentile(durations,.95),p99_ms:percentile(durations,.99),statuses,instances,errors,workloads:Object.fromEntries(Object.entries(groups).map(([name,g])=>{g.durations.sort((a,b)=>a-b);return[name,{attempted:g.attempted,successful:g.successful,failed:g.failed,p95_ms:percentile(g.durations,.95)}]})),...extra};
  }
  return {request,finish};
}
export async function runPhase(options) {
  const {requests,concurrency}=options;assert(Number.isInteger(requests)&&requests>0&&requests<=100000);
  const c=collector(options);let next=0;
  await Promise.all(Array.from({length:concurrency},async()=>{while(true){const index=next++;if(index>=requests)return;await c.request(index);}}));
  return c.finish();
}
export async function runRatePhase(options) {
  const {target_rps,duration_seconds,max_requests=100000,concurrency}=options;
  assert(Number.isInteger(target_rps)&&target_rps>=1&&target_rps<=100000);
  assert(duration_seconds>=.2&&duration_seconds<=30);assert(Number.isInteger(max_requests)&&max_requests>0&&max_requests<=100000);
  const c=collector(options),active=new Set();const started=performance.now();let scheduled=0,launched=0,dropped=0;
  const schedule=due=>{const budget=due-scheduled;scheduled=due;const allowed=Math.max(0,Math.min(budget,concurrency-active.size,max_requests-launched));dropped+=budget-allowed;for(let i=0;i<allowed;i++){const task=c.request(launched++);active.add(task);task.finally(()=>active.delete(task));}};
  while(performance.now()-started<duration_seconds*1000){schedule(Math.floor((performance.now()-started)/1000*target_rps));await new Promise(r=>setTimeout(r,50));}
  schedule(Math.floor(duration_seconds*target_rps));await Promise.all(active);
  return c.finish({target_rps,scheduled_requests:scheduled,dropped_before_send:dropped,scheduled_seconds:duration_seconds});
}
