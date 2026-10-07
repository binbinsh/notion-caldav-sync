import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Providers, CALENDAR_HREF, SOURCE_ID } from './providers.mjs';

export async function harness(t) {
  const providers = new Providers();
  const bundle = await build({ entryPoints: ['src/worker.ts'], bundle: true, format: 'esm', platform: 'browser', write: false, external: ['cloudflare:workers'] });
  const options = { unsafeTriggerHandlers: true, modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-07-08', compatibilityFlags: ['nodejs_compat'], durableObjects: { SYNC: { className: 'SyncObject', useSQLite: true } }, kvNamespaces: ['STATE'], outboundService: request => providers.fetch(request), bindings: { NOTION_TOKEN: 'fixture-notion-token', APPLE_ID: 'fixture@example.test', APPLE_APP_PASSWORD: 'fixture-password', ADMIN_TOKEN: 'fixture-admin', WEBHOOK_SETUP_TOKEN: 'fixture-setup', NOTION_SOURCE_IDS: SOURCE_ID, CALENDAR_HREF, STATUS_EMOJI_STYLE: 'emoji' } };
  const mf = new Miniflare(options);
  t.after(async () => {
    await mkdir('artifacts/e2e', { recursive: true });
    await writeFile(resolve('artifacts/e2e', t.name.replaceAll(/[^a-z0-9]+/gi, '-') + '.trace.json'), JSON.stringify(providers.trace, null, 2));
    await mf.dispose();
  });
  const request = (path, init = {}) => mf.dispatchFetch('https://worker.example.test' + path, { ...init, headers: { 'X-Admin-Token': 'fixture-admin', ...init.headers } });
  return { providers, mf, request, reconfigure: bindings => mf.setOptions({ ...options, bindings: { ...options.bindings, ...bindings } }), sync: () => request('/admin/full-sync', { method: 'POST' }) };
}
