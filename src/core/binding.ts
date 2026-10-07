/** Stable identity for an account's calendar/source binding, independent of rotated secrets. */
export async function bindingFingerprint(connection: {
  APPLE_ID: string; CALENDAR_HREF: string; NOTION_SOURCE_IDS: string; DESCRIPTION_PROPERTY?: string;
}): Promise<string> {
  const identity = JSON.stringify({ appleId: connection.APPLE_ID.toLowerCase().trim(),
    calendar: connection.CALENDAR_HREF.replace(/\/?$/, '/'),
    sources: [...new Set(connection.NOTION_SOURCE_IDS.split(',').map(s => s.trim().replaceAll('-', '').toLowerCase()))].sort(),
    descriptionProperty: connection.DESCRIPTION_PROPERTY || 'Description' });
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity))),
    b => b.toString(16).padStart(2, '0')).join('');
}
