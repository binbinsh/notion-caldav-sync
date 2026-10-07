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

Both deployments use PostgreSQL. Set `DATABASE_URL` to a dedicated PostgreSQL 17+
database; the public single-user service creates `notion_caldav_sync.state`.
For AWS use TLS with hostname/certificate verification (`sslmode=verify-full`)
and the AWS RDS CA bundle through `NODE_EXTRA_CA_CERTS`. Keep the database private.
Do not disable certificate validation.

`DATA_ENCRYPTION_KEY` is a 32-byte key written as 64 hex characters. State, merge
bases and webhook receipts use AES-256-GCM. Keep this key with database backups;
restoring a database without its key fails closed. Preserve the schema name when
restoring because it is part of the authenticated encryption context.
Credentials stay in environment variables and are never stored in the public DB.
AgentMQ uses its existing envelope encryption for private connections and ledgers.

`WEBHOOK_VERIFICATION_TOKEN` can import the Python token after exporting it from
old settings; it does not query D1. Existing ledgers reject a change of account,
calendar, description property or source selection. Use a separate deployment
and an explicit reviewed migration for a changed binding.

`SYNC_INTERVAL_SECONDS=0` disables scheduling (default). Enable a minimum of 60
seconds only after preview and verification. Runs have a 200-request and 180-second
budget, with no automatic provider write retries. PostgreSQL advisory locking also
prevents another instance from writing at the same time.

Admin tokens must be random secrets. Previews and traces include task details:
keep them private even though they omit provider credentials.

Timed Notion dates must include a UTC offset or `Z`; floating timestamps are
rejected rather than interpreted in the host timezone. Date-only values remain
all-day dates. Unsupported schema/recurrence cases must be resolved in preview.
