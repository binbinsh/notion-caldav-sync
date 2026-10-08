import {SyncApplication,type Env} from './application';
import {D1Host,type D1Binding} from './d1';
export interface WorkerEnv extends Env {DB:D1Binding;SCHEDULE_ENABLED?:string;MAX_PROVIDER_CALLS?:string;MAX_D1_QUERIES?:string}
function limit(value:string|undefined,fallback:number,min:number,max:number){const n=Number(value??fallback);if(!Number.isInteger(n)||n<min||n>max)throw Error('Invalid Worker operation budget');return n;}
function application(env:WorkerEnv){return new SyncApplication(env,new D1Host(env.DB,env.DATA_ENCRYPTION_KEY,limit(env.MAX_D1_QUERIES,40,10,900)),{maxProviderCalls:limit(env.MAX_PROVIDER_CALLS,20,1,200)});}
export default {
  async fetch(request:Request,env:WorkerEnv):Promise<Response>{
    try {
      if(request.body){
        const reader=request.body.getReader(),chunks:Uint8Array[]=[];let length=0;
        while(true){const {value,done}=await reader.read();if(done)break;length+=value.length;
          if(length>256*1024){await reader.cancel();return Response.json({error:'Request too large'},{status:413});}chunks.push(value);}
        const body=new Uint8Array(length);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.length;}
        request=new Request(request,{body});
      }
      const response=await application(env).fetch(request),headers=new Headers(response.headers);headers.set('Cache-Control','no-store');
      return new Response(response.body,{status:response.status,headers});
    }catch{return Response.json({status:'failure',error:'Worker configuration or storage failed'},{status:502,headers:{'Cache-Control':'no-store'}});}
  },
  async scheduled(_event:unknown,env:WorkerEnv):Promise<void>{
    if(env.SCHEDULE_ENABLED!=='true')return;
    const response=await application(env).scheduled();
    if(!response.ok)throw Error(`Scheduled synchronization failed: HTTP ${response.status}`);
  },
};
