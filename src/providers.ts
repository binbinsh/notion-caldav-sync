import { XMLParser, XMLValidator } from 'fast-xml-parser';
import ICAL from 'ical.js';
import { CalendarTask, NotionTask, TaskSchema } from './core/models';
import { parsePageToTask } from './core/notion';
import { buildSyncProfile, statusToEmoji, normalizeStatusName, normalizeNotionStatusGroupName } from './core/constants';
import { parseIcsMinimal } from './core/ics';
import { projectNotionTaskToCalendarEvent } from './core/projection';
import type { CalendarPutOptions } from './core/reconciliation';
import type { SyncProvider } from './core/engine';

export interface Connection {
  NOTION_TOKEN: string;
  NOTION_SOURCE_IDS: string;
  APPLE_ID: string;
  APPLE_APP_PASSWORD: string;
  CALENDAR_HREF: string;
  STATUS_EMOJI_STYLE?: string;
  DESCRIPTION_PROPERTY?: string;
  CALENDAR_TIMEZONE?: string;
}
type Json = Record<string, any>;

/** Only provider protocols and schema mapping live here, never tenant management. */
export class Providers implements SyncProvider {
  private sources = new Map<string, Json>();
  private events = new Map<string, { task: CalendarTask; ics: string }>();
  private profile;
  private lastNotionRequest = 0;
  readonly settings: Record<string, unknown>;
  constructor(private connection: Connection, private fetcher: typeof fetch = (...args) => fetch(...args), private options: {notionIntervalMs?:number} = {}) {
    this.profile = buildSyncProfile({ descriptionProperty: connection.DESCRIPTION_PROPERTY || 'Description' });
    this.settings = { calendar_timezone: connection.CALENDAR_TIMEZONE || 'UTC' };
  }

  private async notion(path: string, method = 'GET', body?: Json, allowMissing = false): Promise<Json> {
    const pause = Math.max(0, (this.options.notionIntervalMs ?? 350) - (Date.now() - this.lastNotionRequest));
    if (pause) await new Promise(resolve => setTimeout(resolve, pause));
    this.lastNotionRequest = Date.now();
    const response = await this.fetcher('https://api.notion.com/v1/' + path, {
      method, headers: { Authorization: 'Bearer ' + this.connection.NOTION_TOKEN,
        'Notion-Version': '2025-09-03', 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (allowMissing && response.status === 404) return { missing: true };
    if (!response.ok) throw new Error(`Notion ${method} ${path}: HTTP ${response.status}`);
    return response.json();
  }

  async listNotionTasks(): Promise<NotionTask[]> {
    const ids = [...new Set(this.connection.NOTION_SOURCE_IDS.split(',').map(s => s.trim()).filter(Boolean))];
    if (!ids.length || ids.length > 100) throw new Error('Configure between 1 and 100 Notion data sources.');
    const tasks: NotionTask[] = [];
    for (const id of ids) {
      const schema = await this.notion('data_sources/' + id);
      this.sources.set(id, schema);
      let cursor: string | undefined;
      const seen = new Set<string>();
      for (let count = 0; count < 50; count++) {
        const page = await this.notion(`data_sources/${id}/query`, 'POST', { page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
        if (!Array.isArray(page.results)) throw new Error('Invalid Notion query result.');
        tasks.push(...page.results.map((p: Json) => this.task(p, id)));
        if (tasks.length > 5000) throw new Error('Snapshot exceeds the 5000-task safety limit.');
        if (page.has_more === false) break;
        if (!page.next_cursor || seen.has(page.next_cursor) || count === 49) throw new Error('Incomplete Notion snapshot.');
        cursor = page.next_cursor;
        seen.add(cursor!);
      }
    }
    return tasks;
  }

  async getNotionTask(pageId: string): Promise<NotionTask | null> {
    const page = await this.notion('pages/' + pageId, 'GET', undefined, true);
    // Notion returns 404 for both a removed page and revoked sharing. Only an
    // explicitly archived/trash page can authorize deletion of its calendar pair.
    if (page.missing) throw new Error('Notion page is missing or inaccessible; calendar event preserved.');
    const sourceId = page.parent?.data_source_id;
    if (!this.sources.has(sourceId)) throw new Error('Notion page moved outside the configured sources; calendar event preserved.');
    return this.task(page, sourceId);
  }

  private task(page: Json, sourceId: string): NotionTask {
    const source = this.sources.get(sourceId)!;
    const parsed = parsePageToTask(page, this.profile, source.properties);
    return new NotionTask(parsed.notionId, parsed.url, sourceId,
      (source.title || []).map((t: Json) => t.plain_text || t.text?.content || '').join(''),
      parsed.title, parsed.status, parsed.startDate, parsed.endDate, parsed.reminder, null,
      parsed.description, Boolean(page.archived || page.in_trash), page.last_edited_time || null,
      TaskSchema.fromProperties(source.properties, this.profile));
  }

  async updateNotionFromCalendar(task: NotionTask, event: CalendarTask): Promise<NotionTask> {
    const s = task.schema;
    const properties: Json = {};
    if (s.titleProperty && task.title !== event.title) properties[s.titleProperty] = { title: [{ type: 'text', text: { content: event.title || 'Untitled' } }] };
    if (s.dateProperty && (task.startDate !== event.startDate || task.endDate !== event.endDate)) properties[s.dateProperty] = { date: event.startDate ? { start: event.startDate, end: event.endDate } : null };
    if (s.descriptionProperty && task.description !== event.description) properties[s.descriptionProperty] = { rich_text: richText(event.description || '') };
    if (s.statusProperty && s.statusType && event.status && task.status !== event.status) {
      const definition = this.sources.get(task.databaseId!)!.properties[s.statusProperty][s.statusType];
      const option = (definition.options || []).find((o: Json) => normalizeStatusName(o.name) === event.status)
        || (definition.options || []).find((o: Json) => (definition.groups || []).some((g: Json) =>
          normalizeNotionStatusGroupName(g.name) === event.status && g.option_ids.includes(o.id)));
      if (!option) throw new Error(`No existing Notion status option maps to ${event.status}.`);
      properties[s.statusProperty] = { [s.statusType]: { id: option.id } };
    }
    if (!Object.keys(properties).length) return task;
    await this.assertNotionVersion(task);
    return this.task(await this.notion('pages/' + task.pageId, 'PATCH', { properties }), task.databaseId!);
  }

  async clearNotionSchedule(task: NotionTask): Promise<NotionTask> {
    if (!task.schema.dateProperty) throw new Error('No writable Notion date property.');
    await this.assertNotionVersion(task);
    return this.task(await this.notion('pages/' + task.pageId, 'PATCH', { properties: { [task.schema.dateProperty]: { date: null } } }), task.databaseId!);
  }

  private async assertNotionVersion(task: NotionTask): Promise<void> {
    const current = await this.getNotionTask(task.pageId);
    if (!current || !task.lastEditedTime || current.lastEditedTime !== task.lastEditedTime || current.archived !== task.archived) {
      throw new Error('Notion changed after the scan; retry before writing.');
    }
  }

  private async caldav(href: string, method: string, body?: string, headers: Record<string,string> = {}, allowMissing = false): Promise<Response> {
    const base = new URL(this.connection.CALENDAR_HREF);
    const url = new URL(href);
    if (url.protocol !== 'https:' || url.origin !== base.origin || !url.pathname.startsWith(base.pathname.replace(/\/?$/, '/')) || url.username || url.password) {
      throw new Error('CalDAV request is outside the configured calendar.');
    }
    const response = await this.fetcher(href, { method, headers: { Authorization: 'Basic ' + btoa(this.connection.APPLE_ID + ':' + this.connection.APPLE_APP_PASSWORD),
      'Content-Type': method === 'PUT' ? 'text/calendar; charset=utf-8' : 'application/xml; charset=utf-8', ...headers }, ...(body ? { body } : {}) });
    if (!response.ok && !(allowMissing && response.status === 404)) throw new Error(`CalDAV ${method}: HTTP ${response.status}`);
    return response;
  }

  async listCalendarTasks(): Promise<CalendarTask[]> {
    const response = await this.caldav(this.connection.CALENDAR_HREF, 'REPORT',
      '<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"/></c:comp-filter></c:filter></c:calendar-query>', { Depth: '1' });
    const text = await response.text();
    if (response.status !== 207 || XMLValidator.validate(text) !== true) throw new Error('Incomplete CalDAV snapshot.');
    const xml = new XMLParser({ removeNSPrefix: true, parseTagValue: false }).parse(text);
    if (!Object.hasOwn(xml, 'multistatus')) throw new Error('Invalid CalDAV listing.');
    const rows = array(xml.multistatus.response);
    if (rows.length > 5000) throw new Error('Calendar snapshot exceeds the 5000-event safety limit.');
    this.events.clear();
    const tasks: CalendarTask[] = [];
    for (const row of rows) {
      const stats = array(row.propstat);
      const href = new URL(row.href, this.connection.CALENDAR_HREF).href;
      // iCloud includes the collection itself: it has an ETag but no VEVENT data.
      // Only this exact collection metadata is exempt; failed members stay fatal.
      if (href === this.connection.CALENDAR_HREF && !row.status && stats.every(p =>
        / 200 /.test(p.status || '') || (/ 404 /.test(p.status || '') &&
          Object.keys(p.prop || {}).length === 1 && Object.hasOwn(p.prop || {}, 'calendar-data')))) continue;
      if (row.status || stats.some(p => !/ 200 /.test(p.status || ''))) throw new Error('CalDAV listing contains an unreadable member.');
      const prop = stats.find(p => / 200 /.test(p.status || ''))?.prop;
      if (!prop?.['calendar-data']) {
        if (String(row.href).endsWith('.ics')) throw new Error('Missing CalDAV member data.');
        continue;
      }
      const task = this.parseEvent(href, prop.getetag || null, prop['calendar-data']);
      if (task) { this.events.set(href, { task, ics: prop['calendar-data'] }); tasks.push(task); }
    }
    return tasks;
  }

  private parseEvent(href: string, etag: string | null, ics: string): CalendarTask | null {
    const p = parseIcsMinimal(ics);
    if (!p.notionId) return null;
    const root = new ICAL.Component(ICAL.parse(ics));
    const events = root.getAllSubcomponents('vevent');
    if (events.length !== 1 || ['rrule','rdate','exdate','recurrence-id'].some(name => events[0].hasProperty(name))) {
      throw new Error('Recurring managed calendar events require manual resolution.');
    }
    return new CalendarTask(p.notionId, href, etag, p.title || '', p.status, p.startDate, p.endDate,
      p.reminder, null, p.description, p.lastModified, p.url, p.displayStatus, p.notesFingerprint);
  }

  async getCalendarTask(href: string): Promise<CalendarTask | null> {
    const response = await this.caldav(href, 'GET', undefined, {}, true);
    if (response.status === 404) return null;
    const ics = await response.text();
    const task = this.parseEvent(href, response.headers.get('etag'), ics);
    if (!task) throw new Error('Calendar event exists but its managed identity changed; resolve ownership explicitly.');
    this.events.set(href, { task, ics });
    return task;
  }

  async putCalendarTask(task: NotionTask, options: CalendarPutOptions) {
    const projected = projectNotionTaskToCalendarEvent({ calendarHref: this.connection.CALENDAR_HREF,
      calendarColor: '#FF7F00', notionTask: task, settings: this.settings,
      statusEmojiForStatus: status => statusToEmoji(status, this.connection.STATUS_EMOJI_STYLE || 'emoji') || '' });
    const href = options.eventHref || projected.eventHref;
    // Keep legacy identity and provider-owned properties when updating an existing event.
    const previous = this.events.get(href)?.ics;
    const ics = previous ? mergeManagedEvent(previous, projected.ics) : projected.ics;
    const response = await this.caldav(href, 'PUT', ics,
      options.ifMatch ? { 'If-Match': options.ifMatch } : { 'If-None-Match': '*' });
    return { eventHref: href, etag: response.headers.get('etag') };
  }
  async deleteCalendarEvent(href: string): Promise<void> {
    const observed = this.events.get(href)?.task.etag;
    if (!observed) throw new Error('Calendar deletion requires an observed ETag.');
    await this.caldav(href, 'DELETE', undefined, { 'If-Match': observed }, true);
  }
}
function array(value: any): Json[] { return value == null ? [] : Array.isArray(value) ? value : [value]; }

function richText(text: string): Json[] {
  const result = [];
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(offset + 2000, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end-1])) end--;
    result.push({ type: 'text', text: { content: text.slice(offset, end) } });
    offset = end;
  }
  if (result.length > 100) throw new Error('Description exceeds Notion rich text limits.');
  return result;
}

function mergeManagedEvent(previous: string, projected: string): string {
  const root = new ICAL.Component(ICAL.parse(previous));
  const event = root.getFirstSubcomponent('vevent')!;
  const fresh = new ICAL.Component(ICAL.parse(projected)).getFirstSubcomponent('vevent')!;
  for (const name of ['summary','description','dtstart','dtend','url','status','last-modified','dtstamp',
    'x-notion-page-id','x-notion-status','x-notion-notes-hash']) {
    event.removeAllProperties(name);
    for (const property of fresh.getAllProperties(name)) event.addProperty(property);
  }
  event.updatePropertyWithValue('sequence', Number(event.getFirstPropertyValue('sequence') || 0) + 1);
  // UID, alarms, location, categories, attendees and unknown extensions remain intact.
  return root.toString() + '\r\n';
}
