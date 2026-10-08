import type {Pool} from 'pg';
import {SyncApplication,type Env,type ApplicationOptions,type StateHost} from './application';
import {PostgresState} from './postgres';
export type {Env} from './application';
export interface ServiceOptions extends ApplicationOptions {schema?:string}
export class SyncService extends SyncApplication {
  constructor(pool:Pool,env:Env,options:ServiceOptions={}) {
    const schema=options.schema||'notion_caldav_sync';
    const host:StateHost={storage:'postgresql',withLock:async use=>{
      const client=await pool.connect(),key=`${schema}:single-user`;let held=false;
      try {
        held=(await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS held',[key])).rows[0].held;
        if(!held)return Response.json({error:'A synchronization is already running'},{status:409});
        return await use(new PostgresState(client,env.DATA_ENCRYPTION_KEY,schema),async()=>{});
      }finally{if(held)await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[key]).catch(()=>{});client.release();}
    }};
    super(env,host,options);
  }
}
