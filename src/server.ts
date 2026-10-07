import {createServer} from 'node:http';
import type {Pool} from 'pg';
import {SyncService,type Env,type ServiceOptions} from './service';
export {initializeDatabase} from './postgres';
export function createSyncServer(pool:Pool,env:Env,options:ServiceOptions={}) {
  const service=new SyncService(pool,env,options);
  return createServer(async(req,res)=>{
    try {
      let length=0;const chunks:Buffer[]=[];
      for await(const chunk of req){length+=chunk.length;if(length>256*1024){res.writeHead(413);res.end('{"error":"Request too large"}');return;}chunks.push(chunk);}
      const headers=new Headers();for(const [key,value] of Object.entries(req.headers))if(value)headers.set(key,Array.isArray(value)?value.join(','):value);
      const response=await service.fetch(new Request('http://localhost'+(req.url||'/'),{method:req.method,headers,...(length?{body:Buffer.concat(chunks)}:{})}));
      res.writeHead(response.status,Object.fromEntries(response.headers));res.end(await response.text());
    }catch {res.writeHead(500,{'Content-Type':'application/json'});res.end('{"status":"failure","error":"Request failed"}');}
  });
}
