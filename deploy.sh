#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$SCRIPT_DIR"
CONFIG_PATH="$ROOT_DIR/wrangler.toml"
TEMPLATE_PATH="$ROOT_DIR/wrangler.toml-example"
WRANGLER_AUTH_MODE="${WRANGLER_AUTH_MODE:-oauth}"

cd "$ROOT_DIR"

put_secret() {
  local name=$1
  local value=$2
  printf "%s" "$value" | npm exec wrangler secret put "$name" -- --config wrangler.toml
}

if [ "$WRANGLER_AUTH_MODE" = "oauth" ]; then
  unset CLOUDFLARE_API_TOKEN
  unset CLOUDFLARE_ACCOUNT_ID
  echo "Using Wrangler OAuth authentication."
elif [ "$WRANGLER_AUTH_MODE" = "token" ]; then
  if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
    echo "CLOUDFLARE_ACCOUNT_ID is required when WRANGLER_AUTH_MODE=token." >&2
    exit 1
  fi
  if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
    echo "CLOUDFLARE_API_TOKEN is required when WRANGLER_AUTH_MODE=token." >&2
    exit 1
  fi
  echo "Using Wrangler API token authentication."
else
  echo "Unsupported WRANGLER_AUTH_MODE: $WRANGLER_AUTH_MODE" >&2
  echo "Use WRANGLER_AUTH_MODE=oauth or WRANGLER_AUTH_MODE=token." >&2
  exit 1
fi

if [ -z "${AUTH_DB_DATABASE_ID:-}" ]; then
  echo "AUTH_DB_DATABASE_ID is required for the TypeScript Worker deploy." >&2
  exit 1
fi

APP_BASE_PATH="${APP_BASE_PATH:-/caldav-sync}"

if [ ! -f "$TEMPLATE_PATH" ]; then
  echo "Missing wrangler template at $TEMPLATE_PATH" >&2
  exit 1
fi

if command -v envsubst >/dev/null 2>&1; then
  AUTH_DB_DATABASE_ID="$AUTH_DB_DATABASE_ID" \
  APP_BASE_PATH="$APP_BASE_PATH" \
  envsubst < "$TEMPLATE_PATH" > "$CONFIG_PATH"
else
  sed \
    -e "s/\${AUTH_DB_DATABASE_ID}/$AUTH_DB_DATABASE_ID/g" \
    -e "s|\${APP_BASE_PATH}|$APP_BASE_PATH|g" \
    "$TEMPLATE_PATH" > "$CONFIG_PATH"
fi

echo "Generated wrangler.toml"
echo "AUTH_DB database id: $AUTH_DB_DATABASE_ID"

npm install --ignore-scripts

echo "Building frontend SPA..."
(cd frontend && npm install --ignore-scripts && npm run build)
echo "Frontend build complete."

npm run typecheck

put_secret CLERK_PUBLISHABLE_KEY "${CLERK_PUBLISHABLE_KEY:?CLERK_PUBLISHABLE_KEY must be set}"
put_secret CLERK_SECRET_KEY "${CLERK_SECRET_KEY:?CLERK_SECRET_KEY must be set}"
put_secret APP_ENCRYPTION_KEY "${APP_ENCRYPTION_KEY:?APP_ENCRYPTION_KEY must be set}"

if [ -n "${INTERNAL_SERVICE_TOKEN:-}" ]; then
  put_secret INTERNAL_SERVICE_TOKEN "$INTERNAL_SERVICE_TOKEN"
fi

npm exec wrangler deploy -- --config wrangler.toml

echo "Deployment complete."
echo "The TypeScript Worker is now the deploy target at $APP_BASE_PATH."
