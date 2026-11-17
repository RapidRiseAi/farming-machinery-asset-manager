// Real manual-driving form and styles in headless Chrome; server action is a fixture.
// No account, environment file, provider or deployed service is used.
import { createRequire } from 'node:module';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url);
const { build }=createRequire(require.resolve('tsx/package.json'))('esbuild');
const root=resolve(import.meta.dirname,'..');
const chromePath=['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Google/Chrome/Application/chrome.exe','/usr/bin/google-chrome','/usr/bin/chromium'].find(existsSync);
if(!chromePath)throw new Error('Chrome required for manual driving UI evidence');
const fixture="\nimport React from 'react';import {createRoot} from 'react-dom/client';\nimport {ManualDriveForm} from './src/components/manual-drive-form';\nimport {DialogForm} from './src/components/ui/dialog-form';\nconst id='db000000-0000-4000-9000-000000000001';\nwindow.fixture={fail:true,calls:[],events:[],refreshes:0,version:1};\nconst save=async(draft,context)=>{const f=window.fixture;f.calls.push({draft,context});await new Promise(r=>setTimeout(r,200));\n if(f.changed)return {ok:false,reason:'changed'};if(f.stale)return {ok:false,reason:'stale'};if(f.fail)return {ok:false,reason:'invalid'};if(!f.events.includes(draft.request))f.events.push(draft.request);return {ok:true};};\nwindow.fetch=()=>{throw new Error('Unexpected network request')};\nconst root=createRoot(document.getElementById('root'));\nwindow.renderDrive=(show=true,locale='en',session=false)=>root.render(show?<DialogForm key={locale+session} trigger=\"Start\" title=\"Manual drive fixture\" closeLabel=\"Close\">\n <ManualDriveForm context={{farm:id,kind:session?'depart':'start',session:session?id:null}} user={id} locale={locale} manage={true}\n vehicles={[{id,name:'Truck'}]} drivers={[{id,name:'Driver'}]} initial={{machine:id,driver:id,planVersion:String(window.fixture.version),destination:window.fixture.version===1?'Mill':'Port',stops:window.fixture.version===1?'Depot':'Dock'}} mapOn={false} save={save}/>\n </DialogForm>:<p>Other screen</p>);\nwindow.renderDrive();\n";
const stubs={
 'next/link':`import React from 'react';export default function Link({href,children,...rest}){return <a href={href} {...rest}>{children}</a>}`,
 'next/navigation':`export function useRouter(){return {push(path){window.fixture.pushed=path},refresh(){window.fixture.refreshes++}}}export function usePathname(){return '/chat'}export function useSearchParams(){return new URLSearchParams()}`,
 '@/lib/supabase/client':`export function createClient(){
 const channel={on(_event,_options,fn){window.fixture.tick=fn;return channel},subscribe(){return channel}};
 return {
  channel:()=>channel,removeChannel(){window.fixture.removed=true},
  auth:{onAuthStateChange(fn){window.fixture.auth=fn;return {data:{subscription:{unsubscribe(){}}}}}},
  storage:{from(){return {download:async()=>({data:new Blob(['fixture']),error:null})}}}
 };
 }`,
};
const bundle=await build({stdin:{contents:fixture,resolveDir:root,sourcefile:'manual-drive-fixture.tsx',loader:'tsx'},bundle:true,write:false,format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"development"'},plugins:[{name:'fixture-boundaries',setup(b){b.onResolve({filter:/^(next\/(link|navigation)|@\/lib\/supabase\/client)$/},args=>({path:args.path,namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:stubs[args.path],loader:'tsx',resolveDir:root}));}}]});
const postcss=require('postcss'),tailwind=require('tailwindcss');
const css=(await postcss([tailwind(join(root,'tailwind.config.ts'))]).process(readFileSync(join(root,'src/app/globals.css'),'utf8'),{from:join(root,'src/app/globals.css')})).css;
const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/bundle.js'?'text/javascript':req.url==='/style.css'?'text/css':'text/html');res.end(req.url==='/bundle.js'?bundle.outputFiles[0].text:req.url==='/style.css'?css:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root" style="padding:16px"></div><script src="/bundle.js"></script>');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const profile=mkdtempSync(join(tmpdir(),'fw-manual-drive-ui-'));let chrome,ws;
try{
 chrome=spawn(chromePath,['--headless=new','--remote-debugging-port=9459',`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','--disable-gpu','about:blank'],{stdio:'ignore',windowsHide:true});
 let endpoint;
 for(let i=0;i<80&&!endpoint;i++){try{endpoint=(await(await fetch('http://127.0.0.1:9459/json/list')).json()).find(p=>p.type==='page')?.webSocketDebuggerUrl;}catch{}if(!endpoint)await new Promise(r=>setTimeout(r,100));}
 if(!endpoint)throw new Error('Chrome debugging unavailable');
 ws=new WebSocket(endpoint);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j});
 let sequence=0;const pending=new Map(),errors=[];
 ws.onmessage=event=>{const message=JSON.parse(event.data);if(message.id){const job=pending.get(message.id);pending.delete(message.id);message.error?job.reject(new Error(JSON.stringify(message.error))):job.resolve(message.result)}else if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails);};
 const rpc=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
 const evaluate=async expression=>{const result=await rpc('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description??JSON.stringify(result.exceptionDetails));return result.result.value;};
 const until=async expression=>{for(let i=0;i<100;i++){if(await evaluate(expression))return;await new Promise(r=>setTimeout(r,50));}throw new Error('Timed out: '+expression+'\n'+await evaluate('document.body.innerText'));};
 const click=async label=>evaluate(`(()=>{const scope=document.querySelector('[role="dialog"]')??document;const b=[...scope.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}||b.getAttribute('aria-label')===${JSON.stringify(label)});if(!b||b.disabled)throw new Error('Unavailable button '+${JSON.stringify(label)});b.click()})()`);
 const type=async(selector,value)=>evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 await rpc('Runtime.enable');await rpc('Page.enable');
 await rpc('Emulation.setDeviceMetricsOverride',{width:360,height:800,deviceScaleFactor:1,mobile:true});
 await rpc('Page.navigate',{url:`http://127.0.0.1:${server.address().port}`});

 await until(`document.body.innerText.includes('Start')`);await click('Start');
 await until(`!!document.querySelector('[id$="-km"]')`);
 assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true,'360px layout');
 await type('[id$="-km"]','100,1');await type('[id$="-destination"]','Mill');await type('textarea','Depot\nMill');
 await evaluate('window.renderDrive(false)');await until(`document.body.innerText.includes('Other screen')`);
 await evaluate('window.renderDrive()');await until(`document.body.innerText.includes('Start')`);await click('Start');
 await until(`document.querySelector('[id$="-km"]')?.value==='100,1'`);
 assert.equal(await evaluate('document.querySelector("textarea").value'),'Depot\nMill');
 console.log('PASS Essential manual form, 360px layout, ordered stop draft survives navigation');
 await click('Save');
 await evaluate("document.querySelector('form').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))");
 assert.equal(await evaluate('window.fixture.calls.length'),1,'rapid second submit blocked');
 await until(`document.body.innerText.includes('This update did not finish')`);
 assert.equal(await evaluate('document.querySelector("textarea").value'),'Depot\nMill');
 assert.equal(await evaluate('window.fixture.calls[0].draft.lat'),'', 'no coordinates required');
 await evaluate('window.fixture.fail=false');await click('Save');await until(`!document.querySelector('[role="dialog"]')`);
 assert.equal(await evaluate('window.fixture.calls.length'),2);
 assert.equal(await evaluate('window.fixture.calls[0].draft.request===window.fixture.calls[1].draft.request'),true);
 assert.equal(await evaluate('window.fixture.events.length'),1);
 assert.equal(await evaluate('window.fixture.refreshes'),1);
 console.log('PASS failed save retains values and request ID; retry closes dialog and refreshes');
 await click('Start');await until(`!!document.querySelector('[id$="-km"]')`);
 assert.equal(await evaluate('document.querySelector("textarea").value'),'Depot','saved draft resets to server defaults');
 await type('[id$="-km"]','NaN');await click('Save');await until(`!!document.querySelector('[role="alert"]')`);
 assert.equal(await evaluate('window.fixture.calls.length'),2,'invalid odometer never reaches action');
 await evaluate('window.renderDrive(false)');await until(`document.body.innerText.includes('Other screen')`);
 await evaluate('window.renderDrive(true,"af")');await until(`document.body.innerText.includes('Start')`);await click('Start');
 await until(`document.body.innerText.includes('Kilometerteller')`);
 await rpc('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
 assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true,'desktop layout');

 await evaluate('window.fixture.stale=true;window.renderDrive(true,"en",true)');await until(`document.body.innerText.includes('Start')`);await click('Start');
 await until(`!!document.querySelector('[id$="-notes"]')`);
 await type('[id$="-km"]','125');await type('[id$="-notes"]','Keep these notes');
 await click('Save');await until(`!!document.querySelector('[role="alert"]')`);
 await evaluate('window.fixture.version=2;window.renderDrive(true,"en",true)');
 await until(`[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Reload itinerary'))`);
 assert.equal(await evaluate('document.querySelector("[id$=-destination]").value'),'Mill','refresh alone does not erase draft');
 await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('Reload itinerary')).click()`);
 await until(`document.querySelector('[id$="-destination"]')?.value==='Port'`);
 assert.equal(await evaluate('document.querySelector("[id$=-notes]").value'),'Keep these notes');
 assert.equal(await evaluate('document.querySelector("[id$=-km]").value'),'125');
 await evaluate('window.fixture.stale=false');await click('Save');await until(`!document.querySelector('[role="dialog"]')`);
 assert.equal(await evaluate('window.fixture.calls.at(-1).draft.planVersion'),'2');
 assert.equal(await evaluate('window.fixture.calls.at(-1).draft.request===window.fixture.calls.at(-2).draft.request'),true);
 console.log('PASS stale itinerary recovery adopts latest instructions and keeps notes, km and request');
 await evaluate('window.renderDrive(false)');await until(`document.body.innerText.includes('Other screen')`);
 await evaluate('window.renderDrive()');await until(`document.body.innerText.includes('Start')`);await click('Start');
 await until(`!!document.querySelector('[id$="-notes"]')`);
 await type('[id$="-notes"]','Changed retry draft');
 await evaluate(`window.fixture.stale=false;window.fixture.fail=false;window.fixture.changed=true`);
 await click('Save');await until(`document.body.innerText.includes('Discard this draft')`);
 const usedRequest=await evaluate('window.fixture.calls.at(-1).draft.request');
 await click('Discard this draft and start again');
 await until(`document.querySelector('[id$="-notes"]')?.value===''`);
 await evaluate('window.fixture.changed=false');await click('Save');await until(`!document.querySelector('[role="dialog"]')`);
 assert.notEqual(await evaluate('window.fixture.calls.at(-1).draft.request'),usedRequest,'explicit discard creates a new request');
 console.log('PASS changed retry stays visible until explicit draft discard');
 assert.deepEqual(errors,[],'no browser exceptions');
 console.log('PASS malformed reading refused, saved draft cleared, Afrikaans desktop render');
}finally{
 ws?.close();chrome?.kill();server.close();
 // Only the unique profile created above is removed; check containment before deletion.
 const allowed=resolve(tmpdir())+'\\';
 if(process.platform!=='win32'||resolve(profile).toLowerCase().startsWith(allowed.toLowerCase())){
  for(let i=0;i<10;i++){try{rmSync(profile,{recursive:true,force:true});break;}catch{await new Promise(r=>setTimeout(r,100));}}
 }
}
