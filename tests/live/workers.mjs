// Manual acceptance only. All supplied resources must be disposable and empty.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {resolve} from 'node:path';

if(process.env.LIVE_DISPOSABLE_RESOURCES!=='yes')throw Error('Explicit disposable test resources required');
for(const key of ['LIVE_NOTION_SOURCE_ID','LIVE_CALENDAR_HREF','NOTION_TOKEN','APPLE_ID','APPLE_APP_PASSWORD'])if(!process.env[key])throw Error('Missing '+key);
const root=process.env.LIVE_REPORT_DIR||'artifacts/live-workers';await mkdir(root,{recursive:true});
await build({entryPoints:['src/worker.ts'],outfile:root+'/worker.mjs',bundle:true,platform:'browser',format:'esm',external:['node:*']});
await build({entryPoints:['src/providers.ts'],outfile:root+'/providers.mjs',bundle:true,platform:'node',format:'esm'});
const {Providers}=await import(resolve(root+'/providers.mjs'));
const persist=await mkdtemp(resolve(root+'/d1-'));
const bindings={NOTION_TOKEN:process.env.NOTION_TOKEN,NOTION_SOURCE_IDS:process.env.LIVE_NOTION_SOURCE_ID,APPLE_ID:process.env.APPLE_ID,APPLE_APP_PASSWORD:process.env.APPLE_APP_PASSWORD,CALENDAR_HREF:process.env.LIVE_CALENDAR_HREF,ADMIN_TOKEN:randomUUID(),DATA_ENCRYPTION_KEY:randomBytes(32).toString('hex'),WEBHOOK_SETUP_TOKEN:randomUUID(),SCHEDULE_ENABLED:'false',STATUS_EMOJI_STYLE:'emoji'};
const notionHeaders={Authorization:'Bearer '+bindings.NOTION_TOKEN,'Notion-Version':'2025-09-03','Content-Type':'application/json'};
const appleHeaders={Authorization:'Basic '+btoa(bindings.APPLE_ID+':'+bindings.APPLE_APP_PASSWORD)};
const trace=[],checks=[];let mf,failure,pageId,calls=0,lastNotion=0;
async function transport(input,init){
 if(++calls>40)throw Error('Live test exceeded its 40-call ceiling');
 const request=new Request(input,init),provider=new URL(request.url).hostname==='api.notion.com'?'notion':'caldav';
 if(provider==='notion'){const pause=Math.max(0,400-(Date.now()-lastNotion));if(pause)await new Promise(r=>setTimeout(r,pause));lastNotion=Date.now();}
 try{const response=await fetch(request,{signal:AbortSignal.timeout(20_000)});trace.push({method:request.method,provider,status:response.status});return response;}
 catch(error){trace.push({method:request.method,provider,error:error.cause?.code||error.name});throw error;}
}
async function start(){
 // Explicitly load only the Worker, excluding the adjacent Node provider helper.
 mf=new Miniflare(convertV4MiniflareOptions({modules:[{type:'ESModule',path:'worker.mjs',contents:await readFile(root+'/worker.mjs','utf8')}],compatibilityDate:'2026-10-08',compatibilityFlags:['nodejs_compat'],bindings,d1Databases:{DB:'disposable-live-sync'},resourcePersistencePath:persist,outboundService:async request=>{
  const r=await transport(new Request(request.url,{method:request.method,headers:request.headers,body:['GET','HEAD'].includes(request.method)?undefined:await request.arrayBuffer()}));
  // Node fetch already decompresses its body; avoid a second workerd decode.
  const headers=new Headers(r.headers);headers.delete('Content-Encoding');headers.delete('Content-Length');
  return new Response(r.body,{status:r.status,headers});
 }}));await mf.ready;
}
async function notion(path,method='GET',body){const r=await transport('https://api.notion.com/v1/'+path,{method,headers:notionHeaders,...(body?{body:JSON.stringify(body)}:{})});assert.ok(r.ok,`Notion ${method}: HTTP ${r.status}`);return r.json();}
async function sync(preview=false){const r=await mf.dispatchFetch('https://sync.example.test'+(preview?'/admin/preview':'/admin/full-sync'),{method:preview?'GET':'POST',headers:{'X-Admin-Token':bindings.ADMIN_TOKEN}});const result=await r.json();assert.equal(r.status,200,JSON.stringify(result));return result;}
try {
 await start();const db=await mf.getD1Database('DB');
 for(const sql of (await readFile('migrations/0001_state.sql','utf8')).split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(sql).run();
 const page=await notion('pages','POST',{parent:{type:'data_source_id',data_source_id:bindings.NOTION_SOURCE_IDS},properties:{Title:{title:[{text:{content:'Disposable Worker sync test'}}]},Status:{select:{name:'Todo'}},'Due date':{date:{start:'2099-04-10T09:00:00Z',end:'2099-04-10T10:00:00Z'}},Description:{rich_text:[{text:{content:'Initial notes'}}]}}});pageId=page.id;
 const before=trace.length;await sync(true);assert.equal(trace.slice(before).some(r=>['PUT','PATCH','DELETE'].includes(r.method)),false);checks.push('Worker preview is read-only');
 await sync();const events=await new Providers(bindings,transport).listCalendarTasks();assert.equal(events.length,1);checks.push('Notion creation creates exactly one Apple event through Worker/D1');
 const event=events[0],response=await transport(event.eventHref,{headers:appleHeaders});assert.ok(response.ok);let ics=await response.text();
 assert.match(ics,/Disposable Worker sync test/);assert.match(ics,/Initial notes/);
 ics=ics.replace(/Disposable Worker sync test/g,'Changed in Apple').replace(/Initial notes/g,'Notes from Apple').replace(/20990410T090000Z/g,'20990410T110000Z').replace(/20990410T100000Z/g,'20990410T120000Z').replace(/Status: Todo/g,'Status: Completed').replace(/⬜/g,'✅');
 const changed=await transport(event.eventHref,{method:'PUT',headers:{...appleHeaders,'Content-Type':'text/calendar; charset=utf-8','If-Match':response.headers.get('etag')},body:ics});assert.ok(changed.ok,`CalDAV PUT: HTTP ${changed.status}`);
 await mf.dispose();await start();await sync();const updated=await notion('pages/'+pageId);
 assert.equal(updated.properties.Title.title[0].plain_text,'Changed in Apple');
 assert.equal(updated.properties.Description.rich_text.map(t=>t.plain_text).join(''),'Notes from Apple');
 assert.equal(new Date(updated.properties['Due date'].date.start).toISOString(),'2099-04-10T11:00:00.000Z');
 assert.equal(updated.properties.Status.select.name,'Completed');checks.push('Apple title/date/status/notes reach Notion after Worker restart with persisted D1');
}catch(error){failure=error;}
finally {
 if(pageId)try{await notion('pages/'+pageId,'PATCH',{archived:true});}catch(error){failure??=error;}
 if(mf)try{await mf.dispose();}catch(error){failure??=error;}await rm(persist,{recursive:true,force:true});
 const command='LIVE_DISPOSABLE_RESOURCES=yes node tests/live/workers.mjs (supply the required disposable resource and credential environment variables)';
 await writeFile(root+'/command.txt',command+'\n');
 await writeFile(root+'/result.json',JSON.stringify({passed:!failure,runtime:'workerd with actual D1 SQLite',checks,calls,ceiling:40,retries:0,error:failure?.message,command,trace},null,2));
}
if(failure)throw failure;
console.log(JSON.stringify({passed:true,checks,calls,retries:0}));
