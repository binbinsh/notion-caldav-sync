import {SyncEngine} from './core/engine';
import {StorageLedger} from './core/ledger';
import {Providers, type Connection} from './providers';
import {bindingFingerprint} from './core/binding';
import {version} from '../package.json';
import type {KVLikeStorage} from './core/ledger';

export interface Env extends Connection {
  DATA_ENCRYPTION_KEY: string;
  ADMIN_TOKEN: string;
  WEBHOOK_SETUP_TOKEN: string;
  WEBHOOK_VERIFICATION_TOKEN?: string;
}
export interface ApplicationOptions {fetch?:typeof fetch;notionIntervalMs?:number;maxProviderCalls?:number}
export interface StateHost {storage:string;withLock(use:(state:KVLikeStorage,assertActive:()=>Promise<void>)=>Promise<Response>):Promise<Response>}
export class SyncApplication {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private env: Env,private host:StateHost,private options:ApplicationOptions = {}) {}
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path==='/health'&&request.method==='GET') return Response.json({version,mode:'single-user',direction:'bidirectional',storage:this.host.storage});
    if (!(path==='/webhook/notion'&&request.method==='POST')) {
      if (!this.env.ADMIN_TOKEN||request.headers.get('X-Admin-Token')!==this.env.ADMIN_TOKEN) return Response.json({error:'Unauthorized'},{status:401});
      if (!(path==='/admin/full-sync'&&request.method==='POST')&&!(path==='/admin/preview'&&request.method==='GET')) return Response.json({error:'Not found'},{status:404});
    }
    const run=this.tail.then(()=>this.host.withLock(async (state,assertActive)=>path==='/webhook/notion'?this.webhook(request,state,assertActive):this.sync(state,path==='/admin/preview',assertActive)));
    this.tail=run.catch(()=>{});
    try {return await run;} catch(error) {
      return Response.json({status:'failure',error:error instanceof Error?error.message:'Synchronization failed'},{status:502});
    }
  }
  scheduled(): Promise<Response> {
    return this.fetch(new Request('http://localhost/admin/full-sync',{method:'POST',headers:{'X-Admin-Token':this.env.ADMIN_TOKEN}}));
  }
  private async sync(state:KVLikeStorage,preview=false,assertActive:()=>Promise<void>=async()=>{}):Promise<Response> {
    const binding=await bindingFingerprint(this.env),previous=await state.get('binding');
    if(previous&&previous!==binding)return Response.json({error:'Account/calendar/source binding changed. Use a separate database and an explicit migration.'},{status:409});
    if(!preview&&!previous)await state.put('binding',binding);
    let calls=0;const deadline=Date.now()+180_000,transport=this.options.fetch??fetch;
    const bounded:typeof fetch=async(input,init)=>{
      if(++calls>(this.options.maxProviderCalls??200)||Date.now()>=deadline)throw Error('Provider operation budget reached');
      await assertActive();
      return transport(input,{...init,signal:AbortSignal.timeout(Math.min(30_000,deadline-Date.now()))});
    };
    const providers=new Providers(this.env,bounded,{notionIntervalMs:this.options.notionIntervalMs??(this.options.fetch?0:350)});
    const result=await new SyncEngine(providers,new StorageLedger(state),providers.settings).run(preview?'preview':'full_reconcile',preview);
    if(!preview){const {decisions,...summary}=result;await state.put('lastRun',summary);}
    return Response.json(result,{status:result.totalErrors?409:200});
  }
  private async webhook(request:Request,state:KVLikeStorage,assertActive:()=>Promise<void>):Promise<Response> {
    const text=await request.text();
    if(new TextEncoder().encode(text).byteLength>256*1024)return Response.json({error:'Request too large'},{status:413});
    let data;
    try{data=JSON.parse(text);}catch{return Response.json({error:'Invalid JSON'},{status:400});}
    if(!data||typeof data!=='object'||Array.isArray(data))return Response.json({error:'Invalid event'},{status:400});
    if(data.verification_token){
      const supplied=request.headers.get('X-Webhook-Setup-Token')||new URL(request.url).searchParams.get('setup');
      if(!this.env.WEBHOOK_SETUP_TOKEN||supplied!==this.env.WEBHOOK_SETUP_TOKEN)return Response.json({error:'Unauthorized verification'},{status:401});
      if(typeof data.verification_token!=='string'||data.verification_token.length>256)return Response.json({error:'Invalid token'},{status:400});
      await state.put('verificationToken',data.verification_token);
      return Response.json({verification_token:data.verification_token});
    }
    const token=await state.get('verificationToken')||this.env.WEBHOOK_VERIFICATION_TOKEN;
    const signature=request.headers.get('X-Notion-Signature')?.replace(/^sha256=/,'')||'';
    if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(signature))return Response.json({error:'Invalid signature'},{status:401});
    const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(token),{name:'HMAC',hash:'SHA-256'},false,['verify']);
    const bytes=Uint8Array.from(signature.match(/../g)!,s=>parseInt(s,16));
    if(!await crypto.subtle.verify('HMAC',key,bytes,new TextEncoder().encode(text)))return Response.json({error:'Invalid signature'},{status:401});
    if(typeof data.id!=='string'||data.id.length>256)return Response.json({error:'Missing event ID'},{status:400});
    const seen=((await state.get('webhookReceipts')||[]) as Array<{id:string;at:number}>).filter(r=>Date.now()-r.at<7*86400000);
    if(seen.some(r=>r.id===data.id))return Response.json({replay:true});
    if(data.entity?.type!=='page')return Response.json({ignored:true});
    const result=await this.sync(state,false,assertActive);
    if(result.ok)await state.put('webhookReceipts',[...seen.slice(-255),{id:data.id,at:Date.now()}]);
    return result;
  }
}
