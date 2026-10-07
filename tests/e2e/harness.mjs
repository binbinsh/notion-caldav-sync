import { build } from 'esbuild';
import pg from 'pg';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Providers, CALENDAR_HREF, SOURCE_ID } from './providers.mjs';

let modules;
async function runtime() {
  if (!modules) {
    await build({ entryPoints: ['src/server.ts'], outfile: 'artifacts/e2e/server.mjs', bundle: true, format: 'esm', platform: 'node', external: ['pg'] });
    modules = import(resolve('artifacts/e2e/server.mjs'));
  }
  return modules;
}
export async function harness(t,extraOptions={}) {
  const url = new URL(process.env.TEST_DATABASE_URL || 'postgres://binbinsh@127.0.0.1:55439/notion_sync_test');
  if (!['127.0.0.1','localhost'].includes(url.hostname) || !url.pathname.endsWith('_test')) throw Error('A dedicated loopback _test PostgreSQL database is required');
  const pool = new pg.Pool({connectionString:url.href,max:5});
  const schema = 'test_' + randomUUID().replaceAll('-','');
  const {createSyncServer,initializeDatabase} = await runtime();
  await initializeDatabase(pool,schema);
  const providers = new Providers();
  let env = { NOTION_TOKEN: 'fixture-notion-token', APPLE_ID: 'fixture@example.test', APPLE_APP_PASSWORD: 'fixture-password', ADMIN_TOKEN: 'fixture-admin', WEBHOOK_SETUP_TOKEN: 'fixture-setup', NOTION_SOURCE_IDS: SOURCE_ID, CALENDAR_HREF, STATUS_EMOJI_STYLE: 'emoji', DATA_ENCRYPTION_KEY:'01'.repeat(32) };
  let server,origin;
  async function start() {
    server = createSyncServer(pool,env,{schema,fetch:(input,init)=>providers.fetch(new Request(input,init)),...extraOptions});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  }
  async function close() { if(server)await new Promise(resolve=>server.close(resolve)); }
  await start();
  t.after(async () => {
    await mkdir('artifacts/e2e', { recursive: true });
    await writeFile(resolve('artifacts/e2e', t.name.replaceAll(/[^a-z0-9]+/gi, '-') + '.trace.json'), JSON.stringify(providers.trace, null, 2));
    await close();
    await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  });
  const request = (path,init={}) => fetch(origin+path,{...init,headers:{'X-Admin-Token':'fixture-admin',...init.headers}});
  return {providers,pool,schema,request,
    scheduled:()=>request('/admin/full-sync',{method:'POST'}),
    restart:async()=>{await close();await start();},
    reconfigure:async bindings=>{await close();env={...env,...bindings};await start();},
    sync:()=>request('/admin/full-sync',{method:'POST'})};
}
