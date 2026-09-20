# Host Notion CalDAV Sync for multiple people

Hosted mode lets users connect their own Notion workspace through OAuth and their own Apple Calendar without deploying a Worker. It reuses the open-source sync engine and does not include Planner.li product code.

## Before you start

You need:

- a Cloudflare account;
- one Notion Public Connection;
- one Clerk application;
- a stable `workers.dev` URL or an optional custom domain.

Cloudflare D1, KV, Queues, Cron, migrations, and Worker secrets are provisioned by the setup wizard. Cloudflare has free tiers, but operators remain responsible for usage limits and any charges.

## Deploy

```bash
./scripts/setup-cloudflare.sh
```

Choose `hosted`. The wizard will:

1. sign in to Cloudflare and determine the public URL;
2. show the exact Notion OAuth callback;
3. collect the Notion client ID and secret;
4. collect Clerk's publishable key, JWKS URL, sign-in URL, allowed origin, and administrator user ID;
5. generate the credential-vault key and private webhook setup credential;
6. create or reuse D1, KV, and Queues, apply migrations, and deploy;
7. verify deployment health and guide the required Notion webhook setup.

The OAuth callback is:

```text
https://<worker-url>/notion/callback
```

The webhook subscription URL is shown by the wizard. It contains a private setup credential; do not post it in issues, logs, or screenshots.

## User onboarding

After deployment, each user:

1. signs in with Clerk;
2. authorizes Notion through OAuth;
3. enters an Apple Account email and app-specific password;
4. chooses compatible Notion data sources and an Apple calendar;
5. receives an immediate first sync and automatic reconciliation afterward.

Apple credentials are validated through live CalDAV discovery before storage. Notion OAuth state is short-lived, single-use, and bound to the signed-in Clerk user.

## Administrator access

Only Clerk user IDs listed in `HOSTED_ADMIN_USER_IDS` can open `/admin`. The page shows connections, last completion time, and recent errors, and allows an administrator to pause, resume, or retry a connection.

Set `CLERK_AUTHORIZED_PARTIES` to the exact public origin. The Worker validates Clerk JWT signatures, expiry, subject, session, and authorized party.

## Hosted resources

- **D1:** tenants, installations, encrypted credentials, preferences, jobs, and sync state.
- **KV:** shared Worker state and short-lived hints.
- **Queues:** bounded, retryable sync jobs with a dead-letter queue.
- **Cron:** dispatches connections whose 30-minute reconciliation is due.
- **Worker secrets:** Notion client secret, AES-GCM vault key, and webhook setup credential.

Never replace `CREDENTIAL_VAULT_KEY` on an existing deployment. Existing encrypted tenant credentials cannot be recovered with a new key. The deployment scripts reuse remote secrets when local copies are unavailable and refuse to invent a replacement for an existing D1 database.

See [configuration and operations](configuration.md) for variables and commands, and [hosted service architecture](hosted-service-architecture.md) for the security model and closed-beta limitations.
