import test from 'node:test';
import assert from 'node:assert/strict';
import {workerHarness} from './harness.mjs';
import {PAGE_ID} from '../e2e/providers.mjs';
import {createHmac} from 'node:crypto';
test('Workers and D1 preserve two-way synchronization across an isolate restart',async t=>{
 const h=await workerHarness(t);h.providers.seedPage();
 assert.equal((await (await h.request('/health',{headers:{'X-Admin-Token':''}})).json()).storage,'d1');
 assert.equal((await h.request('/admin/preview',{headers:{'X-Admin-Token':''}})).status,401);
 const preview=await h.request('/admin/preview');assert.equal(preview.status,200);assert.equal(h.providers.events.size,0);
 assert.equal((await h.sync()).status,200);assert.equal(h.providers.events.size,1);
 const href=[...h.providers.events.keys()][0];
 await h.restart();h.providers.editEvent(href,[['Draft task','Calendar revision']]);
 const r=await h.sync();assert.equal(r.status,200,await r.text());
 assert.equal(h.providers.pages.get(PAGE_ID).properties.Title.title[0].text.content,'Calendar revision');
 assert.equal(h.providers.events.size,1);
 const count=h.providers.trace.filter(x=>['PUT','PATCH','DELETE'].includes(x.method)).length;
 assert.equal((await h.sync()).status,200);assert.equal(h.providers.trace.filter(x=>['PUT','PATCH','DELETE'].includes(x.method)).length,count);
});
test('Worker rejects an oversized request before synchronization',async t=>{
 const h=await workerHarness(t);h.providers.seedPage();
 const r=await h.request('/admin/full-sync',{method:'POST',body:'x'.repeat(256*1024+1)});
 assert.equal(r.status,413);assert.equal(h.providers.trace.length,0);
});
test('Independent Worker requests share a D1 lease without duplicate provider work',async t=>{
 const h=await workerHarness(t);h.providers.seedPage();
 let enter,release;const entered=new Promise(r=>enter=r),held=new Promise(r=>release=r);
 h.providers.onRequest=async method=>{if(method==='REPORT'){enter();await held;}};
 const first=h.sync();await entered;const before=h.providers.trace.length;
 try{assert.equal((await h.request('/admin/preview')).status,409);assert.equal(h.providers.trace.length,before);}
 finally{release();}
 assert.equal((await first).status,200);assert.equal(h.providers.events.size,1);
});
test('D1 encrypts state and a wrong key fails closed after restart',async t=>{
 const h=await workerHarness(t);h.providers.seedPage();assert.equal((await h.sync()).status,200);
 const rows=await (await h.db()).prepare('SELECT envelope FROM sync_state').all();
 assert.ok(rows.results.length>=2);assert.ok(rows.results.every(r=>!r.envelope.includes('Draft task')&&!r.envelope.includes('Original notes')));
 await h.restart({DATA_ENCRYPTION_KEY:'02'.repeat(32)});const before=h.providers.trace.length;
 assert.equal((await h.sync()).status,502);assert.equal(h.providers.trace.length,before);
});
test('Signed Worker webhooks persist replay protection and cron is opt-in',async t=>{
 const h=await workerHarness(t);h.providers.seedPage();await h.scheduled();assert.equal(h.providers.trace.length,0);
 assert.equal((await h.request('/webhook/notion',{method:'POST',body:JSON.stringify({verification_token:'fixture-webhook'}),headers:{'X-Webhook-Setup-Token':'fixture-setup'}})).status,200);
 const body=JSON.stringify({id:'fixture-event',entity:{type:'page',id:PAGE_ID}}),signature=createHmac('sha256','fixture-webhook').update(body).digest('hex');
 const event=()=>h.request('/webhook/notion',{method:'POST',body,headers:{'X-Notion-Signature':'sha256='+signature}});
 assert.equal((await event()).status,200);await h.restart({SCHEDULE_ENABLED:'true'});
 const before=h.providers.trace.length;assert.equal((await (await event()).json()).replay,true);assert.equal(h.providers.trace.length,before);
 h.providers.editEvent([...h.providers.events.keys()][0],[['Draft task','Scheduled calendar edit']]);
 await h.scheduled();assert.equal(h.providers.pages.get(PAGE_ID).properties.Title.title[0].text.content,'Scheduled calendar edit');
 assert.equal(h.providers.events.size,1);
});
test('A lost D1 owner cannot acknowledge a provider effect and recovery avoids duplicate writes',async t=>{
 const h=await workerHarness(t);h.providers.seedPage();let injected=false;
 h.providers.onRequest=async method=>{if(method==='PUT'&&!injected){injected=true;await (await h.db()).prepare('UPDATE sync_lock SET expires_at=0 WHERE id=1').run();}};
 const first=await h.sync();assert.notEqual(first.status,200);assert.equal(h.providers.events.size,1);
 const before=h.providers.trace.filter(x=>x.method==='PUT').length;
 h.providers.onRequest=undefined;assert.equal((await h.sync()).status,200);
 assert.equal(h.providers.trace.filter(x=>x.method==='PUT').length,before);
});
test('An unavailable D1 database fails before provider calls',async t=>{
 const h=await workerHarness(t);h.providers.seedPage();await (await h.db()).prepare('DROP TABLE sync_lock').run();
 assert.equal((await h.sync()).status,502);assert.equal(h.providers.trace.length,0);
});
test('Worker provider and D1 query ceilings stop work without automatic retries',async t=>{
 const h=await workerHarness(t);h.providers.seedPage();await h.restart({MAX_PROVIDER_CALLS:'2'});
 assert.notEqual((await h.sync()).status,200);assert.equal(h.providers.trace.length,2);assert.equal(h.providers.events.size,0);
 await h.restart({MAX_PROVIDER_CALLS:'20',MAX_D1_QUERIES:'10'});const before=h.providers.trace.length;
 assert.notEqual((await h.sync()).status,200);assert.ok(h.providers.trace.length-before<=4);assert.equal(h.providers.events.size,0);
});
