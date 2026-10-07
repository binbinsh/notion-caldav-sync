export const PAGE_ID = '11111111-1111-4111-8111-111111111111';
export const SOURCE_ID = '22222222-2222-4222-8222-222222222222';
export const CALENDAR_HREF = 'https://caldav.example.test/calendar/';

export class Providers {
  pages = new Map();
  events = new Map();
  trace = [];
  etag = 0;
  clock = 0;
  failures = [];
  extraSources = new Set();
  onRequest;
  schema = {
    Title: { type: 'title', title: {} },
    Status: { type: 'status', status: { options: [{ id: 'todo', name: 'Not started' }, { id: 'doing', name: 'Doing' }, { id: 'done', name: 'Done' }], groups: [{ name: 'To-do', option_ids: ['todo'] }, { name: 'In progress', option_ids: ['doing'] }, { name: 'Complete', option_ids: ['done'] }] } },
    'Due date': { type: 'date', date: {} },
    Description: { type: 'rich_text', rich_text: {} },
  };
  seedPage(overrides = {}) {
    const page = { object: 'page', id: PAGE_ID, url: `https://www.notion.so/${PAGE_ID}`, parent: { type: 'data_source_id', data_source_id: SOURCE_ID }, archived: false, in_trash: false, last_edited_time: '2026-10-07T00:00:00.000Z', properties: {
      Title: { type: 'title', title: [{ plain_text: 'Draft task', text: { content: 'Draft task' } }] },
      Status: { type: 'status', status: { id: 'todo', name: 'Not started' } },
      'Due date': { type: 'date', date: { start: '2099-04-10T09:00:00.000Z', end: '2099-04-10T10:00:00.000Z' } },
      Description: { type: 'rich_text', rich_text: [{ plain_text: 'Original notes', text: { content: 'Original notes' } }] },
    }, ...overrides };
    this.pages.set(page.id, page);
    return page;
  }
  editPage(id, changes) {
    const page = this.pages.get(id);
    Object.assign(page.properties, changes);
    page.last_edited_time = new Date(Date.UTC(2026, 9, 7, 0, ++this.clock * 2)).toISOString();
    return page;
  }
  editEvent(href, replacements) {
    const event = this.events.get(href);
    for (const [from, to] of replacements) event.ics = event.ics.replace(from, to);
    event.ics = event.ics.replace(/LAST-MODIFIED:[^\r\n]+/, 'LAST-MODIFIED:20261007T020000Z');
    event.etag = `"fixture-${++this.etag}"`;
  }
  async fetch(request) {
    const url = new URL(request.url);
    const method = request.method;
    const text = ['POST', 'PATCH', 'PUT', 'REPORT', 'PROPFIND'].includes(method) ? await request.text() : '';
    this.trace.push({ method, url: url.href, body: text, ifMatch: request.headers.get('if-match'), ifNoneMatch: request.headers.get('if-none-match') });
    if (this.onRequest) await this.onRequest(method, url);
    const failureIndex = this.failures.findIndex(f => f.method === method && url.href.includes(f.path));
    if (failureIndex >= 0) { const [failure] = this.failures.splice(failureIndex, 1); return new Response(failure.body || '', { status: failure.status }); }
    if (url.hostname === 'api.notion.com') {
      const path = url.pathname.replace('/v1/', '');
      if (path === 'search') return Response.json({ results: [{ object: 'data_source', id: SOURCE_ID, title: [{ plain_text: 'Tasks' }] }], has_more: false });
      if (path === `data_sources/${SOURCE_ID}`) return Response.json({ id: SOURCE_ID, object: 'data_source', title: [{ plain_text: 'Tasks' }], properties: this.schema });
      if (path === `data_sources/${SOURCE_ID}/query`) return Response.json({ results: [...this.pages.values()].filter(p => !p.archived && !p.in_trash && p.parent.data_source_id === SOURCE_ID), has_more: false });
      const source = path.match(/^data_sources\/([^/]+)(\/query)?$/);
      if (source && this.extraSources.has(source[1])) return source[2] ? Response.json({results:[],has_more:false}) : Response.json({id:source[1],object:'data_source',title:[],properties:this.schema});
      if (path.startsWith('pages/')) {
        const page = this.pages.get(path.slice(6));
        if (!page) return Response.json({ object: 'error', code: 'object_not_found' }, { status: 404 });
        if (method === 'PATCH') {
          const body = JSON.parse(text);
          for (const [name, value] of Object.entries(body.properties || {})) {
            if ([...(value.title || []), ...(value.rich_text || [])].some(t => t.text.content.length > 2000)) return Response.json({ code: 'validation_error' }, { status: 400 });
            if (value.status) {
              const option = this.schema[name].status.options.find(o => o.name === value.status.name || o.id === value.status.id);
              if (!option) return Response.json({ object: 'error', code: 'validation_error' }, { status: 400 });
              value.status = option;
            }
            const type = this.schema[name].type;
            page.properties[name] = { type, ...value };
          }
          page.last_edited_time = new Date(Date.UTC(2026, 9, 7, 0, ++this.clock * 2)).toISOString();
        }
        return Response.json(page);
      }
    }
    if (url.hostname === 'caldav.example.test') {
      if (method === 'REPORT' || method === 'PROPFIND') {
        const xml = [...this.events.entries()].map(([href, event]) => `<d:response><d:href>${new URL(href).pathname}</d:href><d:propstat><d:prop><d:getetag>${event.etag.replaceAll('"', '&quot;')}</d:getetag><c:calendar-data>${escapeXml(event.ics)}</c:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join('');
        return new Response(`<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">${xml}</d:multistatus>`, { status: 207 });
      }
      if (method === 'GET' || method === 'HEAD') {
        const event = this.events.get(url.href);
        return event ? new Response(method === 'HEAD' ? null : event.ics, { headers: { etag: event.etag } }) : new Response(null, { status: 404 });
      }
      if (method === 'PUT') {
        const existing = this.events.get(url.href);
        if ((request.headers.get('if-none-match') === '*' && existing) || (request.headers.get('if-match') && request.headers.get('if-match') !== existing?.etag)) return new Response(null, { status: 412 });
        const etag = `"fixture-${++this.etag}"`;
        this.events.set(url.href, { ics: text, etag });
        return new Response(null, { status: existing ? 204 : 201, headers: { etag } });
      }
      if (method === 'DELETE') {
        if (request.headers.get('if-match') !== this.events.get(url.href)?.etag) return new Response(null, { status: 412 });
        this.events.delete(url.href); return new Response(null, { status: 204 });
      }
    }
    throw new Error(`Unexpected provider request: ${method} ${url.href}`);
  }
}

function escapeXml(value) { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }
