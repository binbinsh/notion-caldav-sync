import type {KVLikeStorage} from './core/ledger';
import type {StateHost} from './application';
export interface D1Result<T=Record<string,unknown>> {results:T[];meta:{changes:number;rows_read?:number;rows_written?:number}}
export interface D1Statement {bind(...values:unknown[]):D1Statement;first<T=Record<string,unknown>>():Promise<T|null>;all<T=Record<string,unknown>>():Promise<D1Result<T>>;run():Promise<D1Result>}
export interface D1Binding {prepare(sql:string):D1Statement}

export class D1Host implements StateHost {
  storage='d1';
  constructor(private db:D1Binding,private secret:string,private limit=40){}
  async withLock(use:Parameters<StateHost['withLock']>[0]):Promise<Response>{
    if(!/^[a-f0-9]{64}$/i.test(this.secret))throw Error('DATA_ENCRYPTION_KEY must contain 64 hexadecimal characters');
    const owner=crypto.randomUUID(),now=Date.now();let queries=0;
    const query=(sql:string,...values:unknown[])=>{if(++queries>=this.limit)throw Error('D1 query budget reached');return this.db.prepare(sql).bind(...values);};
    // Longer than the 180s run deadline plus its final 30s network timeout.
    const held=await query('INSERT INTO sync_lock(id,owner,expires_at) VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at WHERE sync_lock.expires_at<=? RETURNING owner',owner,now+240_000,now).first<{owner:string}>();
    if(held?.owner!==owner)return Response.json({error:'A synchronization is already running'},{status:409});
    const assertActive=async()=>{if(!await query('SELECT id FROM sync_lock WHERE id=1 AND owner=? AND expires_at>?',owner,Date.now()).first())throw Error('Synchronization lease expired or changed');};
    try{return await use(new D1State(query,owner,this.secret,assertActive),assertActive);}
    finally{await this.db.prepare('DELETE FROM sync_lock WHERE id=1 AND owner=?').bind(owner).run();}
  }
}

class D1State implements KVLikeStorage {
  private key:Promise<CryptoKey>;
  constructor(private query:(sql:string,...values:unknown[])=>D1Statement,private owner:string,secret:string,private assertActive:()=>Promise<void>){
    this.key=crypto.subtle.importKey('raw',Uint8Array.from(secret.match(/../g)!,x=>parseInt(x,16)),{name:'AES-GCM'},false,['encrypt','decrypt']);
  }
  async get(key:string):Promise<unknown>{
    await this.assertActive();const row=await this.query('SELECT envelope FROM sync_state WHERE key=?',key).first<{envelope:string}>();
    return row?this.decrypt(key,row.envelope):undefined;
  }
  async put(key:string,value:unknown):Promise<void>{
    const iv=crypto.getRandomValues(new Uint8Array(12)),data=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:this.aad(key)},await this.key,new TextEncoder().encode(JSON.stringify(value)));
    const envelope=JSON.stringify({v:1,iv:base64(iv),data:base64(new Uint8Array(data))});
    const result=await this.query('INSERT INTO sync_state(key,envelope) SELECT ?,? WHERE EXISTS(SELECT 1 FROM sync_lock WHERE id=1 AND owner=? AND expires_at>?) ON CONFLICT(key) DO UPDATE SET envelope=excluded.envelope',key,envelope,this.owner,Date.now()).run();
    if(result.meta.changes!==1)throw Error('Synchronization lease expired or changed');
  }
  async delete(key:string):Promise<void>{await this.assertActive();await this.query('DELETE FROM sync_state WHERE key=? AND EXISTS(SELECT 1 FROM sync_lock WHERE id=1 AND owner=? AND expires_at>?)',key,this.owner,Date.now()).run();}
  async list(options?:{prefix?:string}){await this.assertActive();const result=await this.query('SELECT key FROM sync_state WHERE substr(key,1,?)=? ORDER BY key LIMIT 5001',(options?.prefix||'').length,options?.prefix||'').all<{key:string}>();if(result.results.length>5000)throw Error('Ledger size limit reached');return {keys:result.results.map(r=>r.key)};}
  async listAll():Promise<Array<Record<string,unknown>>>{await this.assertActive();const result=await this.query("SELECT key,envelope FROM sync_state WHERE key>='ledger:' AND key<'ledger;' ORDER BY key LIMIT 5001").all<{key:string;envelope:string}>();if(result.results.length>5000)throw Error('Ledger size limit reached');return Promise.all(result.results.map(r=>this.decrypt(r.key,r.envelope) as Promise<Record<string,unknown>>));}
  private aad(key:string){return new TextEncoder().encode('notion-caldav-sync:d1:'+key);}
  private async decrypt(key:string,encoded:string):Promise<unknown>{const envelope=JSON.parse(encoded);if(envelope.v!==1)throw Error('Unsupported encrypted state format');const data=await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(envelope.iv),additionalData:this.aad(key)},await this.key,bytes(envelope.data));return JSON.parse(new TextDecoder().decode(data));}
}
function base64(data:Uint8Array){let text='';for(const b of data)text+=String.fromCharCode(b);return btoa(text);}
function bytes(text:string){return Uint8Array.from(atob(text),c=>c.charCodeAt(0));}
