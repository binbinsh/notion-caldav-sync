// Run only on disposable resources supplied by the operator. Not part of CI.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

if(process.env.LIVE_DISPOSABLE_RESOURCES!=='yes')throw Error('Explicit disposable test resources required');
const required=['TEST_DATABASE_URL','LIVE_NOTION_SOURCE_ID','LIVE_CALENDAR_HREF','NOTION_TOKEN','APPLE_ID','APPLE_APP_PASSWORD'];
for(const key of required)if(!process.env[key])throw Error('Missing '+key);
const db=new URL(process.env.TEST_DATABASE_URL);
if(db.hostname!=='127.0.0.1'||!db.pathname.endsWith('_test'))throw Error('Dedicated local _test database required');
const sourceId=process.env.LIVE_NOTION_SOURCE_ID,calendar=process.env.LIVE_CALENDAR_HREF;
const root=process.env.LIVE_REPORT_DIR||'artifacts/live';await mkdir(root,{recursive:true});
await build({entryPoints:['src/server.ts','src/providers.ts'],outdir:root,bundle:true,platform:'node',format:'esm',outExtension:{'.js':'.mjs'},external:['pg']});
const {createSyncServer,initializeDatabase}=await import(resolve(root+'/server.mjs'));
const {Providers}=await import(resolve(root+'/providers.mjs'));
const trace=[];let calls=0,server,pageId,lastNotion=0,pageArchived=false;const checks=[];
const notionHeaders={Authorization:'Bearer '+process.env.NOTION_TOKEN,'Notion-Version':'2025-09-03','Content-Type':'application/json'};
const appleHeaders={Authorization:'Basic '+btoa(process.env.APPLE_ID+':'+process.env.APPLE_APP_PASSWORD)};
async function transport(input,init){
  if(++calls>80)throw Error('Live test exceeded its 80-call ceiling');
  const request=new Request(input,init);
  if(new URL(request.url).hostname==='api.notion.com'){
    const pause=Math.max(0,400-(Date.now()-lastNotion));if(pause)await new Promise(r=>setTimeout(r,pause));lastNotion=Date.now();
  }
  let response;try{response=await fetch(request,{signal:AbortSignal.timeout(20_000)});}catch(error){trace.push({method:request.method,provider:new URL(request.url).hostname==='api.notion.com'?'notion':'caldav',error:error.cause?.code||error.name});throw error;}
  trace.push({method:request.method,provider:new URL(request.url).hostname==='api.notion.com'?'notion':'caldav',status:response.status});
  return response;
}
async function notion(path,method='GET',body){
 const r=await transport('https://api.notion.com/v1/'+path,{method,headers:notionHeaders,...(body?{body:JSON.stringify(body)}:{})});
 assert.equal(r.ok,true,`Notion ${method} HTTP ${r.status}`);return r.json();
}
async function cal(href,method='GET',body,extra={}){
 const r=await transport(href,{method,headers:{...appleHeaders,...extra},...(body?{body}:{})});assert.equal(r.ok,true,`CalDAV ${method} HTTP ${r.status}`);return r;
}
const pool=new pg.Pool({connectionString:db.href,max:4}),schema='live_'+randomUUID().replaceAll('-','');
const env={NOTION_TOKEN:process.env.NOTION_TOKEN,NOTION_SOURCE_IDS:sourceId,APPLE_ID:process.env.APPLE_ID,APPLE_APP_PASSWORD:process.env.APPLE_APP_PASSWORD,CALENDAR_HREF:calendar,ADMIN_TOKEN:randomUUID(),DATA_ENCRYPTION_KEY:randomUUID().replaceAll('-','')+randomUUID().replaceAll('-',''),WEBHOOK_SETUP_TOKEN:randomUUID(),STATUS_EMOJI_STYLE:'emoji'};
let failure;
try {
 await initializeDatabase(pool,schema);
 server=createSyncServer(pool,env,{schema,fetch:transport});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const origin=`http://127.0.0.1:${server.address().port}`;
 async function sync(preview=false){const r=await fetch(origin+(preview?'/admin/preview':'/admin/full-sync'),{method:preview?'GET':'POST',headers:{'X-Admin-Token':env.ADMIN_TOKEN}});const result=await r.json();assert.equal(r.status,200,JSON.stringify(result));return result;}
 const date={start:'2099-04-10T09:00:00Z',end:'2099-04-10T10:00:00Z'};
 const page=await notion('pages','POST',{parent:{type:'data_source_id',data_source_id:sourceId},properties:{Title:{title:[{text:{content:'0.9.0 disposable sync test'}}]},Status:{select:{name:'Todo'}},'Due date':{date},Description:{rich_text:[{text:{content:'Initial notes'}}]}}});pageId=page.id;
 const resume=Boolean(process.env.LIVE_START_AT),skipReverse=process.env.LIVE_START_AT==='deletion';
 const before=trace.length;if(!resume)await sync(true);assert.equal(trace.slice(before).some(r=>['PUT','PATCH','DELETE'].includes(r.method)),false);if(!resume)checks.push('read-only preview');
 await sync();let provider=new Providers(env,transport),events=await provider.listCalendarTasks();assert.equal(events.length,1);let event=events[0];checks.push('Notion creation creates exactly one Apple event');
 if(!resume){await notion('pages/'+pageId,'PATCH',{properties:{Title:{title:[{text:{content:'Changed in Notion'}}]},Description:{rich_text:[{text:{content:'Notes from Notion'}}]}}});await sync();}
 let response=await cal(event.eventHref),ics=await response.text();
 if(!resume){assert.match(ics,/Changed in Notion/);assert.match(ics,/Notes from Notion/);checks.push('Notion title and notes reach Apple');}
 else ics=ics.replace(/0.9.0 disposable sync test/g,'Changed in Notion').replace(/Initial notes/g,'Notes from Notion');
 if(!skipReverse){
 ics=ics.replace(/Changed in Notion/g,'Changed in Apple').replace(/Notes from Notion/g,'Notes from Apple').replace(/20990410T090000Z/g,'20990410T110000Z').replace(/20990410T100000Z/g,'20990410T120000Z').replace(/Status: Todo/g,'Status: Completed').replace(/⬜/g,'✅');
 await cal(event.eventHref,'PUT',ics,{'Content-Type':'text/calendar; charset=utf-8','If-Match':response.headers.get('etag')});
 await sync();const updated=await notion('pages/'+pageId);assert.equal(updated.properties.Title.title[0].plain_text,'Changed in Apple');assert.equal(updated.properties.Description.rich_text.map(t=>t.plain_text).join(''),'Notes from Apple');assert.equal(new Date(updated.properties['Due date'].date.start).toISOString(),'2099-04-10T11:00:00.000Z');assert.equal(updated.properties.Status.select.name,'Completed');checks.push('Apple title/date/status/notes reach Notion');
 }
 let updated;response=await cal(event.eventHref);await cal(event.eventHref,'DELETE',undefined,{'If-Match':response.headers.get('etag')});await sync();updated=await notion('pages/'+pageId);assert.equal(updated.properties['Due date'].date,null);await sync();assert.equal((await new Providers(env,transport).listCalendarTasks()).length,0);checks.push('Calendar deletion clears Notion schedule without resurrection');
 await notion('pages/'+pageId,'PATCH',{properties:{'Due date':{date}}});await sync();events=await new Providers(env,transport).listCalendarTasks();assert.equal(events.length,1);checks.push('Explicit Notion reschedule restores one event');
 await notion('pages/'+pageId,'PATCH',{archived:true});pageArchived=true;await sync();assert.equal((await new Providers(env,transport).listCalendarTasks()).length,0);checks.push('Notion archive removes the owned Apple event');
} catch(error){failure=error;}
finally {
 if(pageId&&!pageArchived)try{await notion('pages/'+pageId,'PATCH',{archived:true});}catch(error){failure??=error;}
 if(server)await new Promise(r=>server.close(r));
 await pool.query(`DROP SCHEMA "${schema}" CASCADE`);await pool.end();
 await writeFile(root+'/result.json',JSON.stringify({passed:!failure,checks,calls,ceiling:80,retries:0,command:'LIVE_DISPOSABLE_RESOURCES=yes node tests/live/check.mjs (see required environment at top of script)',error:failure?.message,trace},null,2));
}
if(failure)throw failure;
console.log(JSON.stringify({passed:true,checks,calls}));
