import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export async function openDemoBrowser(root) {
  const profile = join(root, 'browser'); const browser = spawn(process.env.FLUXSCALE_BROWSER ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', ['--headless=new','--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--no-first-run','about:blank'], { windowsHide:true, stdio:'ignore' });
  let endpoint; const end=Date.now()+25000;
  while (Date.now()<end && !endpoint) { try { const lines=(await readFile(join(profile,'DevToolsActivePort'),'utf8')).trim().split('\n'); endpoint=`ws://127.0.0.1:${lines[0]}${lines[1]}`; } catch { await new Promise(r=>setTimeout(r,200)); } }
  if(!endpoint) { browser.kill(); throw Error('Browser did not start'); }
  const socket=new WebSocket(endpoint); await new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true});});
  let serial=0; const pending=new Map();
  socket.addEventListener('message',event=>{const message=JSON.parse(event.data);const task=pending.get(message.id);if(!task)return;pending.delete(message.id);clearTimeout(task.timer);if(message.error)task.reject(Error('Browser command rejected'));else task.resolve(message.result);});
  function command(method,params={},sessionId){return new Promise((resolve,reject)=>{const id=++serial;const timer=setTimeout(()=>{pending.delete(id);reject(Error(`Browser command timed out: ${method}`));},15000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params,sessionId}));});}
  const {targetId}=await command('Target.createTarget',{url:'about:blank'}); const {sessionId}=await command('Target.attachToTarget',{targetId,flatten:true});
  await command('Target.activateTarget',{targetId});
  const page=(method,params)=>command(method,params,sessionId);
  await page('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await page('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  const evaluate=async expression=>{const result=await page('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error('Browser evaluation failed');return result.result?.value;};
  let visualTail=Promise.resolve();
  function visual(task){const next=visualTail.then(task);visualTail=next.catch(()=>{});return next;}
  // Navigation can leave an in-progress Chromium screenshot unresolved.
  const capture=params=>visual(()=>page('Page.captureScreenshot',{captureBeyondViewport:false,...params}));
  let recording; let encoder; let stopped=false; let frames=0; let encoderError=''; let encodeExit;
  return {
    evaluate,
    async navigate(url){await visual(async()=>{await page('Page.navigate',{url});const deadline=Date.now()+15000;while(!await evaluate(`location.href===${JSON.stringify(url)} && document.readyState==='complete'`)){if(Date.now()>deadline)throw Error('Navigation did not complete');await new Promise(r=>setTimeout(r,100));}await page('Page.bringToFront');});},
    async type(selector,value){await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);await page('Input.insertText',{text:value});},
    async screenshot(path){const shot=await capture({format:'png'});await writeFile(path,Buffer.from(shot.data,'base64'));},
    async startRecording(path,ffmpeg){encoder=spawn(ffmpeg,['-hide_banner','-loglevel','error','-y','-f','image2pipe','-framerate','2','-i','pipe:0','-c:v','libx264','-preset','veryfast','-crf','20','-pix_fmt','yuv420p','-r','24','-movflags','+faststart',path],{windowsHide:true,stdio:['pipe','ignore','pipe']});encoder.on('error',error=>{encoderError=error.message;});encoder.stdin.on('error',error=>{encoderError=error.message;});encoder.stderr.on('data',chunk=>{encoderError+=chunk.toString();});encodeExit=once(encoder,'close');
      recording=(async()=>{while(!stopped){const started=Date.now();if(encoderError)throw Error(encoderError);const shot=await capture({format:'jpeg',quality:85});if(!encoder.stdin.write(Buffer.from(shot.data,'base64')))await once(encoder.stdin,'drain');frames++;await new Promise(r=>setTimeout(r,Math.max(1,500-(Date.now()-started))));}})();recording.catch(error=>console.error(`Recording interrupted after ${frames} frames: ${error.message}`));},
    async stopRecording(){if(!recording)return;stopped=true;try{await recording;}finally{encoder.stdin.end();}const [code]=await encodeExit;if(code!==0)throw Error(`Video encoding failed: ${encoderError}`);return{frames,duration_seconds:frames/2,width:1440,height:1000,fps:24,capture_fps:2};},
    async close(){if(recording&&!stopped)try{await this.stopRecording();}catch{}try{await command('Browser.close');}catch{}socket.close();for(const task of pending.values())clearTimeout(task.timer);browser.kill();},
  };
}
