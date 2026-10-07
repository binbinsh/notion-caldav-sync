import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { harness } from './harness.mjs';
import { PAGE_ID, SOURCE_ID, CALENDAR_HREF } from './providers.mjs';

test('PostgreSQL service propagates Notion creation and calendar edits in both directions', async t => {
  const h = await harness(t);
  h.providers.seedPage();
  let response = await h.sync();
  assert.equal(response.status, 200, await response.text());
  assert.equal(h.providers.events.size, 1);
  const [href, event] = [...h.providers.events.entries()][0];
  assert.match(event.ics, /Draft task/);
  h.providers.editEvent(href, [['Draft task', 'Edited in Apple'], ['20990410T090000Z', '20990410T110000Z'], ['20990410T100000Z', '20990410T120000Z']]);
  response = await h.sync();
  assert.equal(response.status, 200, await response.text());
  const page = h.providers.pages.get(PAGE_ID);
  assert.equal(page.properties.Title.title[0].text.content, 'Edited in Apple');
  assert.equal(page.properties['Due date'].date.start, '2099-04-10T11:00:00.000Z');
  assert.equal(h.providers.events.size, 1);
});

test('Source selection supports the existing account and deduplicates provider calls', async t => {
  const h = await harness(t);
  h.providers.seedPage();
  const ids = [SOURCE_ID, ...Array.from({length:21},(_,i) => `${i.toString(16).padStart(8,'0')}-2222-4222-8222-000000000000`)];
  for (const id of ids.slice(1)) h.providers.extraSources.add(id);
  await h.reconfigure({NOTION_SOURCE_IDS:[...ids,...ids].join(',')});
  const response = await h.sync();
  assert.equal(response.status,200,await response.text());
  assert.equal(h.providers.trace.filter(r => r.method==='POST' && r.url.endsWith('/query')).length,22);
});

test('VTIMEZONE calendar edits preserve the actual UTC instant', async t => {
  const h = await harness(t);
  h.providers.seedPage();
  assert.equal((await h.sync()).status,200);
  const [href] = [...h.providers.events][0];
  h.providers.editEvent(href,[['BEGIN:VEVENT','BEGIN:VTIMEZONE\r\nTZID:Asia/Taipei\r\nBEGIN:STANDARD\r\nDTSTART:19700101T000000\r\nTZOFFSETFROM:+0800\r\nTZOFFSETTO:+0800\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\nBEGIN:VEVENT'],
    ['DTSTART:20990410T090000Z','DTSTART;TZID=Asia/Taipei:20990410T180000'],
    ['DTEND:20990410T100000Z','DTEND;TZID=Asia/Taipei:20990410T190000']]);
  const response = await h.sync();
  assert.equal(response.status,200,await response.text());
  assert.equal(h.providers.pages.get(PAGE_ID).properties['Due date'].date.start,'2099-04-10T10:00:00.000Z');
});

test('A Notion edit after the scan is preserved and reported as a conflict', async t => {
  const h = await harness(t);
  h.providers.seedPage();
  assert.equal((await h.sync()).status, 200);
  const [href] = [...h.providers.events][0];
  h.providers.editEvent(href, [['Draft task','Apple title']]);
  h.providers.onRequest = (method, url) => {
    if (method === 'GET' && url.pathname.includes('/pages/')) {
      h.providers.onRequest = undefined;
      h.providers.editPage(PAGE_ID, { Title: { type: 'title', title: [{ text: { content: 'Concurrent Notion title' } }] } });
    }
  };
  const response = await h.sync();
  assert.equal(response.status, 409, await response.text());
  assert.equal(h.providers.pages.get(PAGE_ID).properties.Title.title[0].text.content, 'Concurrent Notion title');
});

test('Partial two-provider writes keep the old merge base and recover on retry', async t => {
  const h = await harness(t);
  h.providers.seedPage();
  assert.equal((await h.sync()).status, 200);
  const [href] = [...h.providers.events][0];
  h.providers.editEvent(href, [['Draft task','Apple title']]);
  h.providers.editPage(PAGE_ID, { Description: { type: 'rich_text', rich_text: [{ text: { content: 'New Notion notes' } }] } });
  h.providers.failures.push({ method: 'PUT', path: '.ics', status: 500 });
  assert.equal((await h.sync()).status, 409);
  assert.equal((await h.sync()).status, 200);
  assert.equal(h.providers.pages.get(PAGE_ID).properties.Title.title[0].text.content, 'Apple title');
  const ics = h.providers.events.get(href).ics.replace(/\r?\n[ \t]/g, '');
  assert.match(ics, /Apple title/);
  assert.match(ics, /New Notion notes/);
});

test('Legacy webhook verification is imported without rotating the token', async t => {
  const h = await harness(t);
  h.providers.seedPage();
  await h.reconfigure({WEBHOOK_VERIFICATION_TOKEN:'old-verification'});
  const body = JSON.stringify({ id: 'legacy-event', entity: { type: 'page', id: PAGE_ID } });
  const signature = 'sha256=' + createHmac('sha256', 'old-verification').update(body).digest('hex');
  const response = await h.request('/webhook/notion', { method: 'POST', body, headers: { 'X-Notion-Signature': signature } });
  assert.equal(response.status, 200, await response.text());
  assert.equal(h.providers.events.size, 1);
});

test('Changing account or calendar cannot reuse an existing ledger', async t => {
  const h = await harness(t);
  h.providers.seedPage();
  assert.equal((await h.sync()).status, 200);
  const start = h.providers.trace.length;
  await h.reconfigure({ CALENDAR_HREF: 'https://caldav.example.test/different-calendar/' });
  const response = await h.sync();
  assert.equal(response.status, 409, await response.text());
  assert.equal(h.providers.trace.length, start);
});

test('All-day inclusive dates round trip without drift', async t => {
  const h = await harness(t);
  const p = h.providers.seedPage();
  p.properties['Due date'].date = { start: '2099-04-10', end: '2099-04-12' };
  assert.equal((await h.sync()).status, 200);
  const [href, event] = [...h.providers.events][0];
  assert.match(event.ics, /DTEND;VALUE=DATE:20990413/);
  h.providers.editEvent(href, [['20990413','20990414']]);
  assert.equal((await h.sync()).status, 200);
  assert.equal(p.properties['Due date'].date.end, '2099-04-13');
  assert.equal((await h.sync()).status, 200);
  assert.match(h.providers.events.get(href).ics, /DTEND;VALUE=DATE:20990414/);
});

test('Calendar notes round trip long Unicode text and preserve calendar-owned fields', async t => {
  const h = await harness(t);
  h.providers.seedPage();
  assert.equal((await h.sync()).status, 200);
  const [href, event] = [...h.providers.events][0];
  const longNotes = '中文🙂'.repeat(650);
  h.providers.editEvent(href, [['Original notes', longNotes], ['END:VEVENT', 'LOCATION:Private room\r\nCATEGORIES:Personal\r\nX-APPLE-CUSTOM:keep\r\nEND:VEVENT']]);
  const response = await h.sync();
  assert.equal(response.status, 200, await response.text());
  const notes = h.providers.pages.get(PAGE_ID).properties.Description.rich_text.map(t => t.text.content).join('');
  assert.equal(notes, longNotes);
  h.providers.editPage(PAGE_ID, { Title: { type: 'title', title: [{ text: { content: 'Notion change' } }] } });
  assert.equal((await h.sync()).status, 200);
  assert.match(h.providers.events.get(href).ics, /LOCATION:Private room/);
  assert.match(h.providers.events.get(href).ics, /X-APPLE-CUSTOM:keep/);
});

test('Recurring managed events fail closed rather than losing recurrence', async t => {
  const h = await harness(t);
  h.providers.seedPage();
  assert.equal((await h.sync()).status, 200);
  const [href] = [...h.providers.events][0];
  h.providers.editEvent(href, [['END:VEVENT', 'RRULE:FREQ=WEEKLY\r\nEND:VEVENT']]);
  h.providers.editPage(PAGE_ID, { Title: { type: 'title', title: [{ text: { content: 'Do not overwrite recurrence' } }] } });
  const start = h.providers.trace.length;
  const response = await h.sync();
  assert.ok([409,502].includes(response.status), await response.text());
  assert.equal(h.providers.trace.slice(start).some(r => ['PUT','PATCH','DELETE'].includes(r.method)), false);
  assert.match(h.providers.events.get(href).ics, /RRULE:FREQ=WEEKLY/);
});

test('Verified webhook, replay protection and scheduled entry share serialized state', async t => {
  const h = await harness(t);
  h.providers.seedPage();
  assert.equal((await h.request('/admin/full-sync', { method: 'POST', headers: { 'X-Admin-Token': 'wrong' } })).status, 401);
  const verify = await h.request('/webhook/notion', { method: 'POST', headers: { 'X-Webhook-Setup-Token': 'fixture-setup' }, body: JSON.stringify({ verification_token: 'verification-secret' }) });
  assert.equal(verify.status, 200, await verify.text());
  const body = JSON.stringify({ id: 'event-1', type: 'page.properties_updated', entity: { id: PAGE_ID, type: 'page' } });
  const sign = body => 'sha256=' + createHmac('sha256', 'verification-secret').update(body).digest('hex');
  assert.equal((await h.request('/webhook/notion', { method: 'POST', body, headers: { 'X-Notion-Signature': 'sha256=bad' } })).status, 401);
  const webhook = await h.request('/webhook/notion', { method: 'POST', body, headers: { 'X-Notion-Signature': sign(body) } });
  assert.equal(webhook.status, 200, await webhook.text());
  assert.equal(h.providers.events.size, 1);
  const count = h.providers.trace.length;
  const replay = await h.request('/webhook/notion', { method: 'POST', body, headers: { 'X-Notion-Signature': sign(body) } });
  assert.equal(replay.status, 200);
  assert.equal(h.providers.trace.length, count);
  const result = await h.scheduled();
  assert.equal(result.status, 200, await result.text());
  await Promise.all([h.sync(), h.sync(), h.sync()]);
  assert.equal(h.providers.events.size, 1);
});

test('Preview is read only and shows calendar-side changes before migration', async t => {
  const h = await harness(t);
  h.providers.seedPage();
  assert.equal((await h.sync()).status, 200);
  const [href] = [...h.providers.events][0];
  h.providers.editEvent(href, [['Draft task', 'Preview edit']]);
  const start = h.providers.trace.length;
  const response = await h.request('/admin/preview');
  assert.equal(response.status, 200, await response.text());
  assert.equal(h.providers.trace.slice(start).some(r => ['PUT','PATCH','DELETE'].includes(r.method)), false);
  assert.equal(h.providers.pages.get(PAGE_ID).properties.Title.title[0].text.content, 'Draft task');
});

test('Notion access errors cannot delete calendar events, and archives use conditional deletion', async t => {
  const h = await harness(t);
  const p = h.providers.seedPage();
  assert.equal((await h.sync()).status, 200);
  p.archived = true;
  h.providers.failures.push({ method: 'GET', path: 'pages/' + PAGE_ID, status: 403 });
  const start = h.providers.trace.length;
  const denied = await h.sync();
  assert.equal(denied.status, 409, await denied.text());
  assert.equal(h.providers.events.size, 1);
  assert.equal(h.providers.trace.slice(start).some(r => ['PUT','PATCH','DELETE'].includes(r.method)), false);
  assert.equal((await h.sync()).status, 200);
  assert.equal(h.providers.events.size, 0);
  assert.ok(h.providers.trace.find(r => r.method === 'DELETE').ifMatch);
});

for (const failure of [
  { label: 'truncated Notion query', method: 'POST', path: '/query', status: 200, body: JSON.stringify({ results: [], has_more: true }) },
  { label: 'CalDAV outage', method: 'REPORT', path: '/calendar/', status: 500 },
  { label: 'partial CalDAV member error', method: 'REPORT', path: '/calendar/', status: 207, body: '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/calendar/failed.ics</d:href><d:propstat><d:prop/><d:status>HTTP/1.1 403 Forbidden</d:status></d:propstat></d:response></d:multistatus>' },
]) test(failure.label + ' fails closed before mutations', async t => {
  const h = await harness(t);
  h.providers.seedPage();
  assert.equal((await h.sync()).status, 200);
  h.providers.failures.push(failure);
  const start = h.providers.trace.length;
  const response = await h.sync();
  assert.equal(response.status, 502, await response.text());
  assert.equal(h.providers.events.size, 1);
  assert.equal(h.providers.trace.slice(start).some(r => ['PUT','PATCH','DELETE'].includes(r.method)), false);
});

for (const status of [412, 500]) test(`Conditional write HTTP ${status} is never bypassed; retry recovers`, async t => {
  const h = await harness(t);
  h.providers.seedPage();
  assert.equal((await h.sync()).status, 200);
  h.providers.editPage(PAGE_ID, { Title: { type: 'title', title: [{ text: { content: 'Retry title' } }] } });
  h.providers.failures.push({ method: 'PUT', path: '.ics', status });
  const start = h.providers.trace.length;
  const response = await h.sync();
  assert.equal(response.status, 409, await response.text());
  assert.equal(h.providers.trace.slice(start).filter(r => r.method === 'PUT').length, 1);
  assert.ok(h.providers.trace.slice(start).find(r => r.method === 'PUT').ifMatch);
  assert.equal((await h.sync()).status, 200);
  assert.match([...h.providers.events.values()][0].ics, /Retry title/);
});

test('Python restored events are adopted without changing their href or UID', async t => {
  const h = await harness(t);
  h.providers.seedPage();
  const href = CALENDAR_HREF + `notion-caldav-sync-restored-${PAGE_ID}.ics`;
  const uid = `notion-notion-caldav-sync-restored-${PAGE_ID}@sync`;
  h.providers.events.set(href, { etag: '"legacy"', ics: [
    'BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Legacy//EN','BEGIN:VEVENT',`UID:${uid}`,
    'DTSTAMP:20261007T000000Z','LAST-MODIFIED:20261007T000000Z',
    'DTSTART:20990410T090000Z','DTEND:20990410T100000Z','SUMMARY:Draft task',
    'DESCRIPTION:Source: Tasks\\nStatus: Todo\\n\\nOriginal notes',
    `URL:https://www.notion.so/${PAGE_ID}`,'END:VEVENT','END:VCALENDAR','',
  ].join('\r\n') });
  const response = await h.sync();
  assert.equal(response.status, 200, await response.text());
  assert.equal(h.providers.events.size, 1);
  assert.match(h.providers.events.get(href).ics.replace(/\r?\n[ \t]/g, ""), new RegExp(`UID:${uid}`));
  h.providers.editPage(PAGE_ID, { Title: { type: 'title', title: [{ text: { content: '升级后标题' } }] } });
  assert.equal((await h.sync()).status, 200);
  assert.equal(h.providers.events.size, 1);
  assert.match(h.providers.events.get(href).ics, /升级后标题/);
  assert.match(h.providers.events.get(href).ics.replace(/\r?\n[ \t]/g, ""), new RegExp(`UID:${uid}`));
});

test('Unknown events remain untouched and duplicate managed events block writes', async t => {
  const h = await harness(t);
  h.providers.seedPage();
  assert.equal((await h.sync()).status, 200);
  const [href, event] = [...h.providers.events][0];
  const otherId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  h.providers.events.set(href.replace(PAGE_ID, otherId), { ...event, ics: event.ics.replaceAll(PAGE_ID, otherId), etag: '"outside"' });
  assert.equal((await h.sync()).status, 200);
  assert.equal(h.providers.events.size, 2);
  h.providers.events.set(href.replace('.ics', '-duplicate.ics'), { ...event, etag: '"duplicate"' });
  const before = h.providers.trace.length;
  const response = await h.sync();
  assert.equal(response.status, 409, await response.text());
  assert.equal(h.providers.events.size, 3);
  assert.equal(h.providers.trace.slice(before).some(r => ['PUT','PATCH','DELETE'].includes(r.method)), false);
});

test('Apple status edits use existing Notion options and preserve independent field edits', async t => {
  const h = await harness(t);
  h.providers.schema.Status.status.options[2].name = '已完成啦';
  h.providers.seedPage();
  assert.equal((await h.sync()).status, 200);
  const [href, event] = [...h.providers.events][0];
  // Calendar changes title and status; Notion independently changes description.
  const summary = event.ics.match(/SUMMARY:([^\r\n]+)/)[1];
  h.providers.editEvent(href, [[summary, '✅ Apple title']]);
  h.providers.editPage(PAGE_ID, { Description: { type: 'rich_text', rich_text: [{ text: { content: 'Notes edited in Notion' } }] } });
  const response = await h.sync();
  assert.equal(response.status, 200, await response.text());
  const p = h.providers.pages.get(PAGE_ID).properties;
  assert.equal(p.Title.title[0].text.content, 'Apple title');
  assert.equal(p.Status.status.id, 'done');
  assert.equal(p.Description.rich_text[0].text.content, 'Notes edited in Notion');
  assert.match(h.providers.events.get(href).ics, /Notes edited in Notion/);
  const writes = h.providers.trace.filter(r => ['PUT','PATCH'].includes(r.method)).length;
  assert.equal((await h.sync()).status, 200);
  assert.equal(h.providers.trace.filter(r => ['PUT','PATCH'].includes(r.method)).length, writes);
});

test('Calendar deletion clears the date and survives repeated full scans', async t => {
  const h = await harness(t);
  h.providers.seedPage();
  assert.equal((await h.sync()).status, 200);
  h.providers.events.clear();
  const response = await h.sync();
  assert.equal(response.status, 200, await response.text());
  assert.equal(h.providers.pages.get(PAGE_ID).properties['Due date'].date, null);
  assert.equal(h.providers.events.size, 0);
  assert.equal((await h.sync()).status, 200);
  assert.equal(h.providers.events.size, 0);
  h.providers.editPage(PAGE_ID, { 'Due date': { type: 'date', date: { start: '2099-04-11', end: null } } });
  assert.equal((await h.sync()).status, 200);
  assert.equal(h.providers.events.size, 1);
});


test('PostgreSQL retains encrypted merge bases and webhook receipts after a process restart',async t=>{
  const h=await harness(t);h.providers.seedPage();assert.equal((await h.sync()).status,200);
  const [href]=[...h.providers.events.keys()];await h.restart();
  h.providers.editEvent(href,[['Draft task','After restart']]);
  assert.equal((await h.sync()).status,200);
  assert.equal(h.providers.pages.get(PAGE_ID).properties.Title.title[0].text.content,'After restart');
  const stored=await h.pool.query(`SELECT envelope::text FROM "${h.schema}".state`);
  for(const plaintext of ['Original notes','After restart','fixture-password'])assert.equal(JSON.stringify(stored.rows).includes(plaintext),false);
  h.providers.events.clear();await h.restart();assert.equal((await h.sync()).status,200);
  assert.equal(h.providers.pages.get(PAGE_ID).properties['Due date'].date,null);
  await h.restart();assert.equal((await h.sync()).status,200);assert.equal(h.providers.events.size,0);
});

test('A second process holding the PostgreSQL lock prevents any provider calls',async t=>{
  const h=await harness(t);h.providers.seedPage();const client=await h.pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[`${h.schema}:single-user`]);
    assert.equal((await h.sync()).status,409);assert.equal(h.providers.trace.length,0);
  } finally {await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[`${h.schema}:single-user`]);client.release();}
  assert.equal((await h.sync()).status,200);
});

test('A wrong encryption key cannot silently discard or recreate the old ledger',async t=>{
  const h=await harness(t);h.providers.seedPage();assert.equal((await h.sync()).status,200);
  const count=h.providers.trace.length;await h.reconfigure({DATA_ENCRYPTION_KEY:'02'.repeat(32)});
  assert.equal((await h.sync()).status,502);assert.equal(h.providers.trace.length,count);assert.equal(h.providers.events.size,1);
});

test('A missing Notion page is not proof of deletion when access may have been revoked',async t=>{
  const h=await harness(t);h.providers.seedPage();assert.equal((await h.sync()).status,200);
  h.providers.pages.delete(PAGE_ID);const start=h.providers.trace.length;
  assert.equal((await h.sync()).status,409);assert.equal(h.providers.events.size,1);
  assert.equal(h.providers.trace.slice(start).some(r=>['DELETE','PATCH','PUT'].includes(r.method)),false);
});

test('An existing event with changed ownership cannot be treated as a calendar deletion',async t=>{
  const h=await harness(t);h.providers.seedPage();assert.equal((await h.sync()).status,200);
  const [href,event]=[...h.providers.events.entries()][0];
  h.providers.events.set(href,{...event,ics:event.ics.replaceAll(PAGE_ID,'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),etag:'\"new-owner\"'});
  const start=h.providers.trace.length;assert.equal((await h.sync()).status,409);
  assert.equal(h.providers.pages.get(PAGE_ID).properties['Due date'].date.start,'2099-04-10T09:00:00.000Z');
  assert.equal(h.providers.trace.slice(start).some(r=>['DELETE','PATCH','PUT'].includes(r.method)),false);
});

test('iCloud REPORT collection metadata with a missing calendar-data property is not an unreadable event',async t=>{
  const h=await harness(t);h.providers.seedPage();
  h.providers.failures.push({method:'REPORT',path:'/calendar/',status:207,body:'<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/calendar/</d:href><d:propstat><d:prop><d:getetag>collection-etag</d:getetag></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat><d:propstat><d:prop><c:calendar-data/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response></d:multistatus>'});
  const r=await h.sync();assert.equal(r.status,200,await r.text());assert.equal(h.providers.events.size,1);
});


test('Provider calls respect the Notion rate budget through the HTTP entry',async t=>{
 const h=await harness(t,{notionIntervalMs:350});h.providers.seedPage();const times=[];
 h.providers.onRequest=(method,url)=>{if(url.hostname==='api.notion.com')times.push(Date.now());};
 assert.equal((await h.sync()).status,200);assert.ok(times.length>=2);
 for(let i=1;i<times.length;i++)assert.ok(times[i]-times[i-1]>=330,'Notion requests should be spaced');
});


test('Equivalent Notion timezone spellings do not block a confirmed calendar deletion',async t=>{
 const h=await harness(t);const page=h.providers.seedPage();assert.equal((await h.sync()).status,200);
 page.properties['Due date'].date.start='2099-04-10T09:00:00.000+00:00';page.properties['Due date'].date.end='2099-04-10T10:00:00.000+00:00';
 h.providers.events.clear();const response=await h.sync();assert.equal(response.status,200,await response.text());assert.equal(page.properties['Due date'].date,null);
});

test('Rescheduling after an acknowledged deletion works even when Notion reuses the edit timestamp',async t=>{
 const h=await harness(t);const page=h.providers.seedPage();assert.equal((await h.sync()).status,200);
 h.providers.events.clear();assert.equal((await h.sync()).status,200);assert.equal(page.properties['Due date'].date,null);
 page.properties['Due date'].date={start:'2099-04-10T09:00:00.000Z',end:'2099-04-10T10:00:00.000Z'};
 const r=await h.sync();assert.equal(r.status,200,await r.text());assert.equal(h.providers.events.size,1);assert.ok(page.properties['Due date'].date);
});
