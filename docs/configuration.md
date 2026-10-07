# Configuration

Use Notion API version `2025-09-03` data source IDs. Retrieve shared data sources
using `/v1/search` with `filter: {property: "object", value: "data_source"}`. Choose
only the task sources you intend to synchronize and keep their sharing active.

Discover the CalDAV principal using PROPFIND on `https://caldav.icloud.com/`, then
its `calendar-home-set`, then its collections. Set `CALENDAR_HREF` to the exact
existing calendar's HTTPS collection URL including trailing `/`. An explicit
calendar prevents accidental creation or management of an unrelated collection.

`DESCRIPTION_PROPERTY` defaults to `Description`; only this rich text field is
eligible for a notes round trip. Date detection follows Due date, Due, Date,
Deadline, then the first date. Status follows Status, Task Status, Progress, then
status/select. Confirm mapping in the read-only preview before first sync.

`CALENDAR_TIMEZONE` controls date-only overdue display and default reminders.
All-day ranges convert Notion inclusive ends to iCalendar exclusive ends. Timed
dates represent UTC instants; existing calendar timezone components remain.

An optional `STATE` KV binding imports a Python webhook verification token. Worker
sync state uses `SYNC` Durable Objects; AgentMQ uses AWS PostgreSQL. Existing
ledgers reject a change of account, calendar or source selection.

Admin tokens must be random secrets. Previews and traces include task details:
keep them private even though they omit provider credentials.
