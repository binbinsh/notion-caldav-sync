#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
D1_NAME="notion-caldav-sync"
QUEUE_NAME="notion-caldav-sync-jobs"
DLQ_NAME="notion-caldav-sync-jobs-dlq"

cd "$ROOT_DIR"

if ! command -v mise >/dev/null 2>&1; then
  echo "mise is required so the pinned Node.js runtime is used." >&2
  exit 1
fi
NODE_RUNTIME_DIR="$(mise where node@24.21.0)/bin"
export PATH="$NODE_RUNTIME_DIR:$PATH"

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

upsert_env() {
  local key="$1" value="$2" tmp
  touch "$ENV_FILE"
  tmp=$(mktemp)
  grep -vE "^${key}=" "$ENV_FILE" > "$tmp" || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  mv "$tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  export "$key=$value"
}

ensure_default() {
  local key="$1" value="$2"
  if [ -z "${!key:-}" ]; then
    upsert_env "$key" "$value"
  fi
}

if ! uv run -- pywrangler whoami >/dev/null 2>&1; then
  echo "Cloudflare authentication is required. Run: uv run pywrangler login" >&2
  exit 1
fi

if [ -z "${CLOUDFLARE_D1_DATABASE_ID:-}" ]; then
  d1_json=$(npx --yes wrangler d1 list --json)
  CLOUDFLARE_D1_DATABASE_ID=$(
    printf '%s' "$d1_json" | python3 -c '
import json, sys
for row in json.load(sys.stdin):
    if row.get("name") == "notion-caldav-sync":
        print(row.get("uuid") or row.get("id") or "")
        break
'
  )
  if [ -z "$CLOUDFLARE_D1_DATABASE_ID" ]; then
    create_output=$(npx --yes wrangler d1 create "$D1_NAME" --location apac)
    CLOUDFLARE_D1_DATABASE_ID=$(
      printf '%s' "$create_output" | grep -Eo '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -n1
    )
  fi
  if [ -z "$CLOUDFLARE_D1_DATABASE_ID" ]; then
    echo "Unable to resolve the D1 database id." >&2
    exit 1
  fi
  upsert_env CLOUDFLARE_D1_DATABASE_ID "$CLOUDFLARE_D1_DATABASE_ID"
fi

if ! npx --yes wrangler queues info "$QUEUE_NAME" >/dev/null 2>&1; then
  npx --yes wrangler queues create "$QUEUE_NAME"
fi
if ! npx --yes wrangler queues info "$DLQ_NAME" >/dev/null 2>&1; then
  npx --yes wrangler queues create "$DLQ_NAME"
fi

ensure_default CLOUDFLARE_SYNC_QUEUE "$QUEUE_NAME"
ensure_default CLOUDFLARE_SYNC_DLQ "$DLQ_NAME"
ensure_default WORKER_CUSTOM_DOMAIN "calendar.planner.li"
ensure_default PUBLIC_BASE_URL "https://calendar.planner.li"
ensure_default NOTION_CLIENT_ID "338d872b-594c-813b-b0a0-0037f4b3d6f6"
ensure_default CLERK_PUBLISHABLE_KEY "pk_live_Y2xlcmsucGxhbm5lci5saSQ"
ensure_default CLERK_JWKS_URL "https://clerk.planner.li/.well-known/jwks.json"
ensure_default CLERK_SIGN_IN_URL "https://accounts.planner.li/sign-in"
ensure_default CLERK_AUTHORIZED_PARTIES "https://calendar.planner.li,https://accounts.planner.li,https://planner.li,https://www.planner.li,https://api.planner.li,https://clerk.planner.li"
ensure_default HOSTED_SYNC_INTERVAL_MINUTES "30"
ensure_default HOSTED_CRON_BATCH_LIMIT "10"
ensure_default HOSTED_BETA_USER_LIMIT "100"

if [ -z "${CREDENTIAL_VAULT_KEY:-}" ]; then
  CREDENTIAL_VAULT_KEY=$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=\n')
  upsert_env CREDENTIAL_VAULT_KEY "$CREDENTIAL_VAULT_KEY"
fi
if [ -z "${HOSTED_WEBHOOK_SETUP_TOKEN:-}" ]; then
  HOSTED_WEBHOOK_SETUP_TOKEN=$(openssl rand -hex 32)
  upsert_env HOSTED_WEBHOOK_SETUP_TOKEN "$HOSTED_WEBHOOK_SETUP_TOKEN"
fi
if [ -z "${NOTION_CLIENT_SECRET:-}" ]; then
  echo "NOTION_CLIENT_SECRET is not local; deploy.sh will reuse the existing encrypted Worker secret."
fi

"$ROOT_DIR/deploy.sh"

echo "Hosted service deployed at ${PUBLIC_BASE_URL}"
echo "Notion OAuth callback: ${PUBLIC_BASE_URL}/notion/callback"
echo "Notion webhook endpoint: ${PUBLIC_BASE_URL}/webhook/notion/hosted?setup=<HOSTED_WEBHOOK_SETUP_TOKEN>"
