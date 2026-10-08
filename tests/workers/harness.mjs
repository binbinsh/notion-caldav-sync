import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {build} from 'esbuild';
import {mkdtemp,readFile,mkdir,writeFile,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {Providers,SOURCE_ID,CALENDAR_HREF} from '../e2e/providers.mjs';
let built;
export async function workerHarness(t){
 built??=build({entryPoints:['src/worker.ts'],outfile:'artifacts/workers/worker.mjs',bundle:true,format:'esm',platform:'browser',target:'es2022',external:['node:*']});
 await built;await mkdir('artifacts/workers',{recursive:true});
 const persist=await mkdtemp(resolve('artifacts/workers/d1-'));
 const providers=new Providers();
 let bindings={NOTION_TOKEN:'fixture',NOTION_SOURCE_IDS:SOURCE_ID,APPLE_ID:'fixture@example.test',APPLE_APP_PASSWORD:'fixture',CALENDAR_HREF,ADMIN_TOKEN:'fixture-admin',WEBHOOK_SETUP_TOKEN:'fixture-setup',DATA_ENCRYPTION_KEY:'01'.repeat(32),SCHEDULE_ENABLED:'false'};
 let mf;
 async function start(){mf=new Miniflare(convertV4MiniflareOptions({modules:true,scriptPath:resolve('artifacts/workers/worker.mjs'),compatibilityDate:'2026-10-08',compatibilityFlags:['nodejs_compat'],bindings,d1Databases:{DB:'fixture-sync'},resourcePersistencePath:persist,unsafeEnableSharedStorage:true,outboundService:async request=>{const r=await providers.fetch(new Request(request.url,{method:request.method,headers:request.headers,body:['GET','HEAD'].includes(request.method)?undefined:await request.arrayBuffer()}));return new Response(r.body,{status:r.status,headers:r.headers});}}));await mf.ready;}
 await start();
 const db=await mf.getD1Database('DB');
 for(const sql of (await readFile('migrations/0001_state.sql','utf8')).split(';').map(s=>s.trim()).filter(Boolean))await db.prepare(sql).run();
 t.after(async()=>{await writeFile('artifacts/workers/'+t.name.replaceAll(/[^a-z0-9]+/gi,'-')+'.trace.json',JSON.stringify(providers.trace,null,2));await mf.dispose();await rm(persist,{recursive:true,force:true});});
 const request=(path,init={})=>mf.dispatchFetch('https://sync.example.test'+path,{...init,headers:{'X-Admin-Token':'fixture-admin',...init.headers}});
 return {providers,request,sync:()=>request('/admin/full-sync',{method:'POST'}),db:()=>mf.getD1Database('DB'),restart:async values=>{await mf.dispose();bindings={...bindings,...values};await start();},scheduled:async()=>{const w=await mf.getWorker();return w.scheduled({cron:'*/30 * * * *',scheduledTime:Date.now()});}};
}
