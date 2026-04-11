#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$SCRIPT_DIR"
CONFIG_PATH="$ROOT_DIR/wrangler.toml"
TEMPLATE_PATH="$ROOT_DIR/wrangler.toml-example"
AUTH_CACHE_NAMESPACE_NAME="caldav-sync-service-AUTH-CACHE"

cd "$ROOT_DIR"

discover_namespace_id() {
  if list_json=$(npm exec wrangler kv namespace list -- --json 2>/dev/null); then
    printf '%s' "$list_json" | node -e '
      const fs = require("fs");
      const title = process.argv[1];
      const data = JSON.parse(fs.readFileSync(0, "utf8"));
      const entries = Array.isArray(data) ? data : (data.result || []);
      const match = entries.find((entry) => entry && entry.title === title);
      if (match && match.id) process.stdout.write(String(match.id));
    ' "$AUTH_CACHE_NAMESPACE_NAME" || true
  fi
}

namespace_exists() {
  local namespace_id=${1:-}
  if list_json=$(npm exec wrangler kv namespace list -- --json 2>/dev/null); then
    if printf '%s' "$list_json" | node -e '
      const fs = require("fs");
      const target = process.argv[1];
      const data = JSON.parse(fs.readFileSync(0, "utf8"));
      const entries = Array.isArray(data) ? data : (data.result || []);
      process.exit(entries.some((entry) => entry && entry.id === target) ? 0 : 1);
    ' "$namespace_id" >/dev/null; then
      return 0
    fi
  fi
  return 1
}

ensure_auth_cache_namespace() {
  if [ -n "${AUTH_CACHE_NAMESPACE_ID:-}" ]; then
    if namespace_exists "$AUTH_CACHE_NAMESPACE_ID"; then
      echo "AUTH_CACHE namespace already set: $AUTH_CACHE_NAMESPACE_ID"
      return
    fi
    echo "Provided AUTH_CACHE_NAMESPACE_ID was not found. Rediscovering or creating AUTH_CACHE namespace..." >&2
    unset AUTH_CACHE_NAMESPACE_ID
  fi

  existing_id=$(discover_namespace_id)
  if [ -n "$existing_id" ]; then
    AUTH_CACHE_NAMESPACE_ID="$existing_id"
    export AUTH_CACHE_NAMESPACE_ID
    echo "Found existing AUTH_CACHE namespace id: $AUTH_CACHE_NAMESPACE_ID"
    return
  fi

  echo "Creating AUTH_CACHE namespace \"$AUTH_CACHE_NAMESPACE_NAME\" ..."
  if output=$(npm exec wrangler kv namespace create "$AUTH_CACHE_NAMESPACE_NAME" 2>&1); then
    :
  else
    create_status=$?
  fi
  if [ "${create_status:-0}" -ne 0 ]; then
    echo "$output"
    exit 1
  fi
  AUTH_CACHE_NAMESPACE_ID=$(
    printf "%s\n" "$output" | node -e '
      const fs = require("fs");
      const text = fs.readFileSync(0, "utf8");
      const match = text.match(/id\\s*=\\s*\"([^\"]+)\"/);
      if (match) process.stdout.write(match[1]);
    ' || true
  )
  if [ -z "$AUTH_CACHE_NAMESPACE_ID" ]; then
    echo "$output"
    echo "Unable to parse AUTH_CACHE namespace id. Please set AUTH_CACHE_NAMESPACE_ID manually."
    exit 1
  fi
  export AUTH_CACHE_NAMESPACE_ID
}

put_secret() {
  local name=$1
  local value=$2
  printf "%s" "$value" | npm exec wrangler secret put "$name" -- --config wrangler.toml
}

if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  echo "CLOUDFLARE_ACCOUNT_ID is required for Wrangler operations." >&2
  exit 1
fi

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "CLOUDFLARE_API_TOKEN is required for Wrangler operations." >&2
  exit 1
fi

if [ -z "${AUTH_DB_DATABASE_ID:-}" ]; then
  echo "AUTH_DB_DATABASE_ID is required for the TypeScript Worker deploy." >&2
  exit 1
fi

APP_BASE_PATH="${APP_BASE_PATH:-/caldav-sync}"
BETTER_AUTH_BASE_URL="${BETTER_AUTH_BASE_URL:-https://superplanner.ai${APP_BASE_PATH}}"
TURNSTILE_SITE_KEY="${TURNSTILE_SITE_KEY:-}"

ensure_auth_cache_namespace

if [ ! -f "$TEMPLATE_PATH" ]; then
  echo "Missing wrangler template at $TEMPLATE_PATH" >&2
  exit 1
fi

if command -v envsubst >/dev/null 2>&1; then
  AUTH_CACHE_NAMESPACE_ID="$AUTH_CACHE_NAMESPACE_ID" \
  AUTH_DB_DATABASE_ID="$AUTH_DB_DATABASE_ID" \
  APP_BASE_PATH="$APP_BASE_PATH" \
  BETTER_AUTH_BASE_URL="$BETTER_AUTH_BASE_URL" \
  TURNSTILE_SITE_KEY="$TURNSTILE_SITE_KEY" \
  envsubst < "$TEMPLATE_PATH" > "$CONFIG_PATH"
else
  sed \
    -e "s/\${AUTH_CACHE_NAMESPACE_ID}/$AUTH_CACHE_NAMESPACE_ID/g" \
    -e "s/\${AUTH_DB_DATABASE_ID}/$AUTH_DB_DATABASE_ID/g" \
    -e "s|\${APP_BASE_PATH}|$APP_BASE_PATH|g" \
    -e "s|\${BETTER_AUTH_BASE_URL}|$BETTER_AUTH_BASE_URL|g" \
    -e "s/\${TURNSTILE_SITE_KEY}/$TURNSTILE_SITE_KEY/g" \
    "$TEMPLATE_PATH" > "$CONFIG_PATH"
fi

echo "Generated wrangler.toml"
echo "AUTH_CACHE namespace id: $AUTH_CACHE_NAMESPACE_ID"
echo "AUTH_DB database id: $AUTH_DB_DATABASE_ID"

npm install --ignore-scripts
npm run typecheck

put_secret BETTER_AUTH_SECRET "${BETTER_AUTH_SECRET:?BETTER_AUTH_SECRET must be set}"
put_secret APP_ENCRYPTION_KEY "${APP_ENCRYPTION_KEY:?APP_ENCRYPTION_KEY must be set}"
put_secret NOTION_CLIENT_ID "${NOTION_CLIENT_ID:?NOTION_CLIENT_ID must be set}"
put_secret NOTION_CLIENT_SECRET "${NOTION_CLIENT_SECRET:?NOTION_CLIENT_SECRET must be set}"

if [ -n "${INTERNAL_SERVICE_TOKEN:-}" ]; then
  put_secret INTERNAL_SERVICE_TOKEN "$INTERNAL_SERVICE_TOKEN"
fi

if [ -n "${TURNSTILE_SECRET_KEY:-}" ]; then
  put_secret TURNSTILE_SECRET_KEY "$TURNSTILE_SECRET_KEY"
fi

npm exec wrangler deploy -- --config wrangler.toml

echo "Deployment complete."
echo "The TypeScript Worker is now the deploy target at $APP_BASE_PATH."
