# Configuration and operations

The setup wizard writes `.env` with owner-only permissions. You do not need to create it by hand. Use `.env.example` only for headless deployment or as a reference.

## Common values

| Key | Purpose |
| --- | --- |
| `DEPLOYMENT_MODE` | `personal` or `hosted` |
| `WORKER_CUSTOM_DOMAIN` | Optional hostname; blank uses `workers.dev` |
| `CLOUDFLARE_ACCOUNT_ID` | Optional selector when your login has multiple accounts |
| `CLOUDFLARE_API_TOKEN` | Optional for headless deployment; interactive setup uses OAuth |
| `CLOUDFLARE_STATE_NAMESPACE` | Created or discovered automatically |
| `STATUS_EMOJI_STYLE` | `emoji` (default) or `symbol` |

Personal mode also uses `NOTION_TOKEN`, `APPLE_ID`, `APPLE_APP_PASSWORD`, `ADMIN_TOKEN`, and the private `WEBHOOK_SETUP_TOKEN` used only to authorize Notion's verification handshake.

Hosted mode uses `PUBLIC_BASE_URL`, Notion OAuth values, Clerk values, D1 and Queue identifiers, `HOSTED_ADMIN_USER_IDS`, `CREDENTIAL_VAULT_KEY`, and `HOSTED_WEBHOOK_SETUP_TOKEN`. The last three provider secrets are uploaded as encrypted Worker secrets.

## Headless deployment

Fill `.env` from `.env.example`, authenticate Cloudflare with `CLOUDFLARE_API_TOKEN`, then run:

```bash
./deploy.sh
```

For hosted resource provisioning:

```bash
./scripts/provision-hosted-cloudflare.sh
```

Interactive users should prefer `./scripts/setup-cloudflare.sh` because it also guides provider setup and webhook verification.

## Personal admin endpoints

```bash
curl -X POST -H "X-Admin-Token: $ADMIN_TOKEN" https://<worker-url>/admin/full-sync
curl -H "X-Admin-Token: $ADMIN_TOKEN" https://<worker-url>/admin/settings
curl -H "X-Admin-Token: $ADMIN_TOKEN" https://<worker-url>/admin/debug
```

`ADMIN_TOKEN` protects every `/admin/*` endpoint. Keep it private.

## Title status style

The default is `emoji`:

| Style | Todo | In progress | Completed | Overdue | Cancelled |
| --- | --- | --- | --- | --- | --- |
| `emoji` | ⬜ | ⚙️ | ✅ | ⚠️ | ❌ |
| `symbol` | ○ | ⊖ | ✓⃝ | ⊜ | ⊗ |

Set `STATUS_EMOJI_STYLE=symbol` in `.env` and redeploy to use symbols.

## Operational behavior

- `/health` is public and returns Worker reachability only.
- Webhooks drive real-time updates; scheduled reconciliation repairs drift.
- Cron runs every five minutes. A connection normally becomes due 30–35 minutes after its previous successful run.
- Notion may aggregate webhook events. The Worker fetches current page data before writing Calendar changes.
- Renaming or recoloring the Apple calendar is safe; the Worker reuses its recorded calendar identity.
- Changing or resetting the main Apple Account password revokes app-specific passwords and requires reconnection.
