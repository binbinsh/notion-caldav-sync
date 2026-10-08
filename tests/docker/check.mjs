import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';

const execute=promisify(execFile),image=process.env.TEST_DOCKER_IMAGE||'notion-caldav-sync:0.9.1-test';
const context=process.env.TEST_DOCKER_CONTEXT||'default';
const prefix='notion-sync-test-'+randomUUID().slice(0,8),pg=prefix+'-pg',app=prefix+'-app',network=prefix+'-net';
const commands=[],checks=[],startedAt=new Date().toISOString();
let failure,imageId,diagnostics;
async function docker(...args){
 const argv=['--context',context,...args];commands.push(['docker',...argv]);
 const result=await execute('docker',argv,{timeout:120_000,maxBuffer:1024*1024});return result.stdout.trim();
}
try {
 imageId=await docker('image','inspect',image,'--format','{{.Id}}'); // Build the reviewed image explicitly first.
 await docker('network','create',network);
 await docker('run','-d','--name',pg,'--network',network,'-e','POSTGRES_PASSWORD=fixture','-e','POSTGRES_DB=notion_sync_test',
  '-v',resolve('tests/docker/slow-init.sql')+':/docker-entrypoint-initdb.d/slow-init.sql:ro','postgres:17-alpine');
 let ready=false;
 for(let attempt=0;attempt<30;attempt++){
  try{await docker('exec',pg,'pg_isready','-h','127.0.0.1','-U','postgres','-d','notion_sync_test');ready=true;break;}catch{}
  await new Promise(r=>setTimeout(r,500));
 }
 assert.ok(ready,'PostgreSQL must become ready');
 await docker('run','-d','--name',app,'--network',network,'-p','127.0.0.1::8787',
  '-e',`DATABASE_URL=postgres://postgres:fixture@${pg}:5432/notion_sync_test`,
  '-e','DATA_ENCRYPTION_KEY='+'01'.repeat(32),'-e','NOTION_TOKEN=fixture',
  '-e','NOTION_SOURCE_IDS=22222222-2222-4222-8222-222222222222',
  '-e','APPLE_ID=fixture@example.test','-e','APPLE_APP_PASSWORD=fixture',
  '-e','CALENDAR_HREF=https://caldav.example.test/calendar/','-e','ADMIN_TOKEN=fixture-admin',image);
 const port=(await docker('port',app,'8787/tcp')).split(':').at(-1),origin='http://127.0.0.1:'+port;
 let health;
 for(let attempt=0;attempt<30;attempt++){
  try{const r=await fetch(origin+'/health',{signal:AbortSignal.timeout(1000)});if(r.ok){health=await r.json();break;}}catch{}
  await new Promise(r=>setTimeout(r,500));
 }
 assert.equal(health?.version,'0.9.1');checks.push('Packaged HTTP service starts');
 assert.equal((await fetch(origin+'/admin/preview')).status,401);
 assert.equal((await fetch(origin+'/admin/full-sync',{method:'POST'})).status,401);checks.push('Admin endpoints require authentication');
 assert.match(await docker('logs',app),/"scheduleEnabled":false/);checks.push('Scheduling remains disabled by default');
 assert.equal(await docker('exec',app,'id','-u'),'1000');checks.push('Service runs as a non-root user');
 assert.equal(await docker('exec',pg,'psql','-U','postgres','-d','notion_sync_test','-Atc',"SELECT to_regclass('notion_caldav_sync.state')"),'notion_caldav_sync.state');checks.push('PostgreSQL state initializes');
} catch(error){
 failure=error instanceof Error?error.message:String(error);diagnostics={};
 for(const name of [app,pg])try{const logs=await execute('docker',['--context',context,'logs',name],{timeout:10000,maxBuffer:1024*1024});diagnostics[name]=logs.stdout+logs.stderr;}catch{}
}
finally {
 for(const name of [app,pg])try{await docker('rm','-f',name);}catch{}
 try{await docker('network','rm',network);}catch{}
 await mkdir('artifacts/docker',{recursive:true});
 const command=`TEST_DOCKER_CONTEXT=${context} TEST_DOCKER_IMAGE=${image} node tests/docker/check.mjs`;
 await writeFile('artifacts/docker/command.txt',command+'\n');
 await writeFile('artifacts/docker/result.json',JSON.stringify({command,imageId,startedAt,completedAt:new Date().toISOString(),passed:!failure,checks,error:failure??null,diagnostics,commands,liveProviderRequests:0},null,2)+'\n');
}
if(failure)throw Error(failure);
console.log(JSON.stringify({passed:true,checks,liveProviderRequests:0}));
