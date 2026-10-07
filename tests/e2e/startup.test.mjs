import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {build} from 'esbuild';
import {writeFile,mkdir} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';

test('The independently bundled Node service starts with PostgreSQL and scheduling disabled',async t=>{
 const db=new URL(process.env.TEST_DATABASE_URL||'postgres://binbinsh@127.0.0.1:55439/notion_sync_test');
 assert.equal(db.hostname,'127.0.0.1');assert.ok(db.pathname.endsWith('_test'));
 const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 await build({entryPoints:['src/main.ts'],outfile:'artifacts/e2e/startup.mjs',bundle:true,platform:'node',format:'esm',external:['pg']});
 const args=['artifacts/e2e/startup.mjs'];const env={PATH:process.env.PATH,DATABASE_URL:db.href,DATA_ENCRYPTION_KEY:randomBytes(32).toString('hex'),NOTION_TOKEN:'fixture',NOTION_SOURCE_IDS:'22222222-2222-4222-8222-222222222222',APPLE_ID:'fixture@example.test',APPLE_APP_PASSWORD:'fixture',CALENDAR_HREF:'https://caldav.example.test/calendar/',ADMIN_TOKEN:'fixture',HOST:'127.0.0.1',PORT:String(port),SYNC_INTERVAL_SECONDS:'0'};
 const child=spawn(process.execPath,args,{env,stdio:['ignore','pipe','pipe']});let transcript='';
 for(const stream of [child.stdout,child.stderr])stream.on('data',d=>{transcript+=d;});
 t.after(async()=>{child.kill('SIGTERM');await new Promise(r=>child.exitCode===null?child.once('close',r):r());await mkdir('artifacts/e2e',{recursive:true});await writeFile('artifacts/e2e/startup-transcript.json',JSON.stringify({command:[process.execPath,...args].join(' '),database:(()=>{const u=new URL(db);u.password='';return u.href;})(),transcript},null,2));});
 let response;for(let i=0;i<50;i++){try{response=await fetch(`http://127.0.0.1:${port}/health`);break;}catch{await new Promise(r=>setTimeout(r,100));}}
 assert.equal(response?.status,200,transcript);assert.equal((await response.json()).storage,'postgresql');assert.match(transcript,/"scheduleEnabled":false/);
 assert.equal((await fetch(`http://127.0.0.1:${port}/admin/full-sync`,{method:'POST'})).status,401);
});
