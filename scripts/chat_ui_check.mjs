// Real React/components/styles in headless Chrome; API, Realtime and microphone are fixtures.
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
if(!chromePath)throw new Error('Chrome required for chat UI evidence');
const fixture=`
import React from 'react';import {createRoot} from 'react-dom/client';
import {ChatRoomClient} from './src/components/chat/chat-room';
import {ChatHome} from './src/components/chat/chat-home';
const room='bc200000-0000-4000-9000-000000000001',user='bc100000-0000-4000-9000-000000000002',farm='bc000000-0000-4000-9000-000000000001';
window.fixture={room,user,farm,denied:false,failSend:false,sends:[],messages:[],requests:[],delay:0};
window.fetch=async(path,options={})=>{
 const f=window.fixture;f.requests.push(String(path));const url=new URL(path,location.origin),body=options.body?JSON.parse(options.body):null;
 const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
 if(url.pathname.startsWith('/api/uploads'))return json({code:'upload-storage-full'},400);
 if(url.pathname!='/api/chat')throw new Error('Unexpected fixture request '+path);
 if(f.denied)return json({},403);
 if(body){
  if(body.action==='send'){f.sends.push(body);await new Promise(r=>setTimeout(r,100));if(f.failSend)return json({},500);
   if(!f.messages.some(m=>m.id===body.id))f.messages.push({id:body.id,sender_id:user,sequence:1,body:body.body,published_at:new Date().toISOString(),edited_at:null,deleted_at:null});}
  return json({data:body.action==='create'?room:null});
 }
 if(url.searchParams.has('draft'))return json({attachments:[]});
 if(url.searchParams.has('farm'))return json({data:url.searchParams.has('people')?[{id:'bc100000-0000-4000-9000-000000000003',name:'Colleague'}]:[{id:room,title:'Fixture team',kind:'group',people:['Colleague'],unread:2}]});
 const query=url.searchParams.get('search');const messages=query?f.messages.filter(m=>m.body.includes(query)):f.messages;
 const response={room:{id:room,farm_id:farm,title:'Fixture team',kind:'group',can_write:true,members:[{id:user,name:'Sender',admin:true},{id:'bc100000-0000-4000-9000-000000000003',name:'Colleague'}]},messages,attachments:[]};
 if(f.delay){const delay=f.delay;f.delay=0;await new Promise(r=>setTimeout(r,delay));}
 return json(response);
};
Object.defineProperty(navigator,'mediaDevices',{value:{getUserMedia:async()=>({getTracks:()=>[{stop(){window.fixture.micStopped=true}}]})}});
window.MediaRecorder=class{static isTypeSupported(){return true}constructor(){this.state='inactive';this.mimeType='audio/webm'}start(){if(window.fixture.recordFail)throw new Error('fixture recorder start failure');this.state='recording'}stop(){this.state='inactive';this.ondataavailable?.({data:new Blob(['fixture voice'],{type:'audio/webm'})});this.onstop?.()}};
const app=createRoot(document.getElementById('root'));
window.renderChat=(home=false,locale='en')=>app.render(home?<ChatHome key={'home'+locale} farm={farm} locale={locale}/>:<ChatRoomClient key={'room'+locale} id={room} user={user} locale={locale}/>);
window.renderChat();
`;
const stubs={
 'next/link':`import React from 'react';export default function Link({href,children,...rest}){return <a href={href} {...rest}>{children}</a>}`,
 'next/navigation':`export function useRouter(){return {push(path){window.fixture.pushed=path}}}export function usePathname(){return '/chat'}export function useSearchParams(){return new URLSearchParams()}`,
 '@/lib/supabase/client':`export function createClient(){
 const channel={on(_event,_options,fn){window.fixture.tick=fn;return channel},subscribe(){return channel}};
 return {
  channel:()=>channel,removeChannel(){window.fixture.removed=true},
  auth:{onAuthStateChange(fn){window.fixture.auth=fn;return {data:{subscription:{unsubscribe(){}}}}}},
  storage:{from(){return {download:async()=>({data:new Blob(['fixture']),error:null})}}}
 };
 }`,
};
const bundle=await build({stdin:{contents:fixture,resolveDir:root,sourcefile:'chat-fixture.tsx',loader:'tsx'},bundle:true,write:false,format:'iife',jsx:'automatic',define:{'process.env.NODE_ENV':'"development"'},plugins:[{name:'fixture-boundaries',setup(b){b.onResolve({filter:/^(next\/(link|navigation)|@\/lib\/supabase\/client)$/},args=>({path:args.path,namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:stubs[args.path],loader:'tsx',resolveDir:root}));}}]});
const postcss=require('postcss'),tailwind=require('tailwindcss');
const css=(await postcss([tailwind(join(root,'tailwind.config.ts'))]).process(readFileSync(join(root,'src/app/globals.css'),'utf8'),{from:join(root,'src/app/globals.css')})).css;
const server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/bundle.js'?'text/javascript':req.url==='/style.css'?'text/css':'text/html');res.end(req.url==='/bundle.js'?bundle.outputFiles[0].text:req.url==='/style.css'?css:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><div id="root" style="padding:16px"></div><script src="/bundle.js"></script>');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const profile=mkdtempSync(join(tmpdir(),'fw-chat-ui-'));let chrome,ws;
try{
 chrome=spawn(chromePath,['--headless=new','--remote-debugging-port=9458',`--user-data-dir=${profile}`,'--no-first-run','--no-default-browser-check','--disable-gpu','about:blank'],{stdio:'ignore',windowsHide:true});
 let endpoint;
 for(let i=0;i<80&&!endpoint;i++){try{endpoint=(await(await fetch('http://127.0.0.1:9458/json/list')).json()).find(p=>p.type==='page')?.webSocketDebuggerUrl;}catch{}if(!endpoint)await new Promise(r=>setTimeout(r,100));}
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
 await until(`document.body.innerText.includes('Write a message')`);
 assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true,'360px layout');
 await click('Write a message');await until(`!!document.querySelector('textarea')&&!document.querySelector('textarea').disabled`);
 await type('textarea','Draft survives navigation');
 await evaluate('window.renderChat(true)');await until(`document.body.innerText.includes('New conversation')`);
 await evaluate('window.renderChat()');await until(`document.body.innerText.includes('Write a message')`);
 await click('Write a message');await until(`document.querySelector('textarea')?.value==='Draft survives navigation'`);
 console.log('PASS mobile layout and draft survives component navigation');
 await evaluate('window.fixture.failSend=true');await click('Send');await until(`document.body.innerText.includes('This did not finish')`);
 assert.equal(await evaluate(`document.querySelector('textarea').value`),'Draft survives navigation');
 await evaluate('window.fixture.failSend=false');await click('Send');await until(`!document.querySelector('[role="dialog"]')`);
 assert.equal(await evaluate('window.fixture.sends.length'),2);
 assert.equal(await evaluate('window.fixture.sends[0].id===window.fixture.sends[1].id'),true);
 assert.equal(await evaluate('window.fixture.messages.length'),1);
 console.log('PASS failed send preserves draft and retry identity; success closes dialog');
 await click('Write a message');await until(`!!document.querySelector('textarea')&&!document.querySelector('textarea').disabled`);
 assert.equal(await evaluate(`document.querySelector('textarea').value`),'');
 await click('Add attachments');await until(`document.body.innerText.includes('Record a voice note')`);
 await evaluate('window.fixture.recordFail=true');await click('Record a voice note');
 await until(`document.body.innerText.includes('The microphone or recording could not start')`);
 assert.equal(await evaluate(`document.body.innerText.includes('Stop recording')`),false,'failed recorder must not lock the dialog');
 await evaluate('window.fixture.recordFail=false');
 await click('Record a voice note');await until(`document.body.innerText.includes('Stop recording')`);
 await evaluate('window.fixture.realNow=Date.now;Date.now=()=>window.fixture.realNow()+600001');
 await until(`document.body.innerText.includes('Attach this recording')`);await click('Attach this recording');
 await evaluate('Date.now=window.fixture.realNow');
 await until(`(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Discard recording');return b&&!b.disabled&&!!document.querySelector('[role="alert"]')&&window.fixture.requests.includes('/api/uploads/begin')})()`);
 await click('Discard recording');await until(`document.body.innerText.includes('Record a voice note')`);
 assert.equal(await evaluate('window.fixture.micStopped'),true);
 await type('textarea','Text after failed voice upload');await click('Send');await until(`!document.querySelector('[role="dialog"]')`);
 console.log('PASS ten-minute recorder limit with accelerated clock; failed upload can be discarded and text remains usable');
 await evaluate('window.fixture.delay=600;window.fixture.tick()');
 await click('Search messages');await until(`!!document.querySelector('[role="dialog"] input')`);
 await type('[role="dialog"] input','no-such-text');await click('Search messages');await click('Close');
 await until(`document.body.innerText.includes('No messages to show')`);
 await new Promise(r=>setTimeout(r,700));
 assert.equal(await evaluate('document.querySelectorAll("ol li").length'),0,'an older response cannot overwrite the current search');
 console.log('PASS stale response cannot replace newer search results');
 await evaluate('window.fixture.denied=true;window.fixture.tick()');await until(`document.body.innerText.includes('You no longer have access')`);
 assert.equal(await evaluate(`document.querySelectorAll('ol li').length`),0);
 assert.equal(await evaluate(`document.body.innerText.includes('Write a message')`),false);
 console.log('PASS revoked membership clears messages and composer');
 await evaluate('window.fixture.denied=false;window.renderChat(true,"af")');await until(`document.body.innerText.includes('Fixture team')`);
 await rpc('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
 assert.equal(await evaluate('document.documentElement.scrollWidth<=innerWidth'),true,'desktop layout');
 assert.equal(await evaluate(`/chat\\.[a-zA-Z]/.test(document.body.innerText)`),false);
 assert.deepEqual(errors,[],'no browser exceptions');
 console.log('PASS desktop Afrikaans render with no missing chat keys or browser exceptions');
}finally{
 ws?.close();chrome?.kill();server.close();
 // Only the unique profile created above is removed; check containment before deletion.
 const allowed=resolve(tmpdir())+'\\';
 if(process.platform!=='win32'||resolve(profile).toLowerCase().startsWith(allowed.toLowerCase())){
  for(let i=0;i<10;i++){try{rmSync(profile,{recursive:true,force:true});break;}catch{await new Promise(r=>setTimeout(r,100));}}
 }
}
