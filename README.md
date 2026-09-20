# Notion CalDAV Sync

[![Python 3.12+](https://img.shields.io/badge/python-3.12%2B-blue?logo=python)](pyproject.toml)
[![CI](https://github.com/binbinsh/notion-caldav-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/binbinsh/notion-caldav-sync/actions/workflows/ci.yml)
[![Cloudflare Workers](https://img.shields.io/badge/platform-Cloudflare%20Workers-F38020?logo=cloudflare)](https://developers.cloudflare.com/workers/)
[![Notion API](https://img.shields.io/badge/Notion%20API-2026--03--11-black?logo=notion&logoColor=white)](https://developers.notion.com/reference/intro)
[![iCloud Calendar](https://img.shields.io/badge/iCloud%20Calendar-CalDAV-0C7BFA?logo=icloud&logoColor=white)](src/app/calendar.py)

One-way sync from dated Notion tasks to Apple Calendar. Notion stays the source of truth: calendar edits are never written back.

Webhooks request a sync after Notion changes. A scheduled reconciliation runs every 30 minutes to repair missed, delayed, or out-of-order deliveries.

## Choose your setup

- **Use the free managed service:** open [calendar.planner.li](https://calendar.planner.li/), sign in, connect Notion, add an Apple app-specific password, and choose what to sync. No deployment is required.
- **Deploy for yourself:** run the setup wizard below. A free Cloudflare `workers.dev` address is included, so you do not need a domain.
- **Host for multiple people:** follow the [hosted service guide](docs/hosting.md). This advanced mode adds Notion OAuth, Clerk, D1, and Queues.

## Deploy for yourself

You need:

- a free Cloudflare account;
- a Notion internal connection with read-content access;
- an Apple Account with two-factor authentication and an [app-specific password](https://support.apple.com/en-us/102654);
- [uv](https://docs.astral.sh/uv/) and either Node.js with `npx` or [mise](https://mise.jdx.dev/).

```bash
git clone https://github.com/binbinsh/notion-caldav-sync.git
cd notion-caldav-sync
./scripts/setup-cloudflare.sh
```

Choose `personal` and press Enter at the domain prompt to use the free `workers.dev` URL. The wizard then:

1. signs in to Cloudflare;
2. captures secrets without echoing them;
3. creates or reuses the KV namespace;
4. deploys the Worker and Cron trigger;
5. walks you through the required Notion webhook verification;
6. runs the first full sync.

The only dashboard work that cannot be automated is creating the Notion connection, choosing its page access, generating the Apple app-specific password, and confirming the Notion webhook. Re-running the wizard keeps values already saved in the local, git-ignored `.env` file.

## Your Notion data source

The managed picker accepts data sources with at least one date property and one status/select property.

| Field | Recognized property names | Type | Required |
| --- | --- | --- | --- |
| Title | `Title`, otherwise the first title property | Title | Yes |
| Status | `Status`, `Task Status`, `Progress` | Status or Select | Recommended |
| Date | `Due date`, `Due`, `Date`, `Deadline` | Date | Yes |
| Reminder | `Reminder`, `Notification` | Date | No |
| Category | `Category`, `Tags`, `Tag`, `Type`, `Class` | Select | No |
| Description | `Description` | Rich text | No |

Pages without a start date are skipped.

## Reliability and safety

- The Notion webhook is required for real-time updates and is verified with HMAC-SHA256.
- Cron checks for due work every five minutes; the default full reconciliation interval is 30 minutes.
- Existing calendars are managed only through recorded or prefixed event resources. Unknown events are preserved.
- The legacy calendar name `Notion` keeps compatibility with earlier deployments and its recorded-event deletion boundary.
- Provider credentials are stored as encrypted Worker secrets in personal mode. Hosted tenant credentials are encrypted with AES-GCM before D1 storage.
- A free hostname does not guarantee that every workload stays inside Cloudflare's free usage limits.

## Updating or operating a deployment

Run the same wizard again to update a deployment:

```bash
./scripts/setup-cloudflare.sh
```

For configuration, headless deployment, admin endpoints, and title styles, see [configuration and operations](docs/configuration.md).

## Development

```bash
uv sync --group dev
uv run ruff check src tests
uv run pytest -m "not integration"
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow, [SECURITY.md](SECURITY.md) for private vulnerability reporting, and [the hosted architecture](docs/hosted-service-architecture.md) for trust boundaries and the data model.

## License

MIT — see [LICENSE](LICENSE).
