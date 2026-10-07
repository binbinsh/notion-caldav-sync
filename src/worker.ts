import { DurableObject } from 'cloudflare:workers';
import { SyncEngine } from './core/engine';
import { StorageLedger } from './core/ledger';
import { Providers, type Connection } from './providers';
import { bindingFingerprint } from './core/binding';

export interface Env extends Connection {
  SYNC: DurableObjectNamespace<SyncObject>;
  STATE?: KVNamespace;
  ADMIN_TOKEN: string;
  WEBHOOK_SETUP_TOKEN: string;
}

export class SyncObject extends DurableObject<Env> {
  private tail: Promise<unknown> = Promise.resolve();
  async fetch(request: Request): Promise<Response> {
    const run = this.tail.then(async () => {
      const url = new URL(request.url);
      if (url.pathname === '/webhook/notion') return this.webhook(request);
      return this.sync(url.pathname === '/admin/preview');
    });
    this.tail = run.catch(() => {});
    try { return await run; } catch(error) {
      return Response.json({ status: 'failure', error: error instanceof Error ? error.message : String(error) }, { status: 502 });
    }
  }

  private async sync(preview = false): Promise<Response> {
      const binding = await bindingFingerprint(this.env);
      const previous = await this.ctx.storage.get<string>('binding');
      if (previous && previous !== binding) return Response.json({ error: 'Account/calendar/source binding changed. Export the ledger and migrate into a new Worker before synchronizing.' }, { status: 409 });
      if (!preview && !previous) await this.ctx.storage.put('binding', binding);
      const provider = new Providers(this.env);
      const ledger = new StorageLedger({
        get: key => this.ctx.storage.get(key),
        put: (key,value) => this.ctx.storage.put(key,value),
        delete: async key => { await this.ctx.storage.delete(key); },
        list: async options => ({ keys: [...(await this.ctx.storage.list(options)).keys()] }),
      });
      const result = await new SyncEngine(provider, ledger, provider.settings).run(preview ? 'preview' : 'full_reconcile', preview);
      if (!preview) await this.ctx.storage.put('lastRun', result);
      return Response.json(result, { status: result.totalErrors ? 409 : 200 });
  }

  private async webhook(request: Request): Promise<Response> {
    const text = await boundedText(request);
    const data = JSON.parse(text);
    if (data.verification_token) {
      const supplied = request.headers.get('X-Webhook-Setup-Token') || new URL(request.url).searchParams.get('setup');
      if (!this.env.WEBHOOK_SETUP_TOKEN || supplied !== this.env.WEBHOOK_SETUP_TOKEN) return Response.json({ error: 'Unauthorized verification' }, { status: 401 });
      if (typeof data.verification_token !== 'string' || data.verification_token.length > 256) return Response.json({ error: 'Invalid token' }, { status: 400 });
      await this.ctx.storage.put('verificationToken', data.verification_token);
      return Response.json({ verification_token: data.verification_token });
    }
    let token = await this.ctx.storage.get<string>('verificationToken');
    if (!token && this.env.STATE) {
      const field = await this.env.STATE.get('settings:value:webhook_verification_token');
      const legacy = field ? JSON.parse(field) : (await this.env.STATE.get<{ webhook_verification_token?: string }>('settings', 'json'))?.webhook_verification_token;
      if (typeof legacy === 'string' && legacy.length <= 256) {
        token = legacy;
        await this.ctx.storage.put('verificationToken', token);
      }
    }
    const signature = request.headers.get('X-Notion-Signature')?.replace(/^sha256=/, '') || '';
    if (!token || !/^[a-f0-9]{64}$/.test(signature)) return Response.json({ error: 'Invalid signature' }, { status: 401 });
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const bytes = Uint8Array.from(signature.match(/../g)!, s => parseInt(s,16));
    if (!await crypto.subtle.verify('HMAC', key, bytes, new TextEncoder().encode(text))) return Response.json({ error: 'Invalid signature' }, { status: 401 });
    if (typeof data.id !== 'string' || data.id.length > 256) return Response.json({ error: 'Missing event ID' }, { status: 400 });
    const seen = (await this.ctx.storage.get<Array<{ id: string; at: number }>>('webhookReceipts') || [])
      .filter(r => Date.now() - r.at < 7 * 86400000);
    if (seen.some(r => r.id === data.id)) return Response.json({ replay: true });
    if (data.entity?.type !== 'page') return Response.json({ ignored: true });
    const result = await this.sync();
    if (result.ok) await this.ctx.storage.put('webhookReceipts', [...seen.slice(-255), { id: data.id, at: Date.now() }]);
    return result;
  }
}

function stub(env: Env) { return env.SYNC.get(env.SYNC.idFromName('single-user')); }
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/health') return Response.json({ version: '0.9.0', mode: 'single-user', direction: 'bidirectional' });
    if (path === '/webhook/notion' && request.method === 'POST') return stub(env).fetch(request);
    if (!env.ADMIN_TOKEN || request.headers.get('X-Admin-Token') !== env.ADMIN_TOKEN) return Response.json({ error: 'Unauthorized' }, { status: 401 });
    if (path === '/admin/full-sync' && request.method === 'POST') return stub(env).fetch(request);
    if (path === '/admin/preview' && request.method === 'GET') return stub(env).fetch(request);
    return Response.json({ error: 'Not found' }, { status: 404 });
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(stub(env).fetch('https://sync.internal/run', { method: 'POST' }).then(r => { if (!r.ok) throw new Error('Scheduled sync failed'); }));
  },
} satisfies ExportedHandler<Env>;

async function boundedText(request: Request): Promise<string> {
  if (!request.body) throw new Error('Request body is required.');
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let text = '', length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 256 * 1024) { await reader.cancel(); throw new Error('Request body exceeds 256 KiB.'); }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
