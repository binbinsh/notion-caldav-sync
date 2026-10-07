import pg from 'pg';
import {createSyncServer,initializeDatabase} from './server';
import {SyncService,type Env} from './service';

for(const name of ['DATABASE_URL','DATA_ENCRYPTION_KEY','NOTION_TOKEN','NOTION_SOURCE_IDS','APPLE_ID','APPLE_APP_PASSWORD','CALENDAR_HREF','ADMIN_TOKEN']){
  if(!process.env[name])throw Error(`Missing ${name}`);
}
if(!/^[a-f0-9]{64}$/i.test(process.env.DATA_ENCRYPTION_KEY!))throw Error('DATA_ENCRYPTION_KEY requires 64 hexadecimal characters');
const interval=Number(process.env.SYNC_INTERVAL_SECONDS||0);
if(!Number.isInteger(interval)||(interval!==0&&interval<60))throw Error('SYNC_INTERVAL_SECONDS must be 0 (disabled) or at least 60');
const port=Number(process.env.PORT||8787);
if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid PORT');
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,max:4,connectionTimeoutMillis:5000});
await initializeDatabase(pool);
const env=process.env as unknown as Env,server=createSyncServer(pool,env),service=new SyncService(pool,env);
await new Promise<void>(resolve=>server.listen(port,process.env.HOST||'127.0.0.1',resolve));
console.log(JSON.stringify({version:'0.9.0',port,scheduleEnabled:interval>0}));
let stopped=false,timer:NodeJS.Timeout|undefined;
async function tick(){
  try{const r=await service.scheduled();if(!r.ok)console.error(JSON.stringify({event:'scheduled_sync_failed',status:r.status}));}
  catch{console.error(JSON.stringify({event:'scheduled_sync_failed'}));}
  if(!stopped)timer=setTimeout(tick,interval*1000);
}
if(interval)timer=setTimeout(tick,interval*1000);
async function stop(){stopped=true;if(timer)clearTimeout(timer);await new Promise<void>(resolve=>server.close(()=>resolve()));await pool.end();}
process.once('SIGINT',stop);process.once('SIGTERM',stop);
