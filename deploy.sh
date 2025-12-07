#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$SCRIPT_DIR"
CONFIG_PATH="$ROOT_DIR/wrangler.toml"
TEMPLATE_PATH="$ROOT_DIR/wrangler.toml-example"
HELPERS_PATH="$ROOT_DIR/scripts/deploy_helpers.py"
STATE_NAMESPACE_NAME="notion-caldav-sync-STATE"  # Change if you prefer a different namespace title.

cd "$ROOT_DIR"

reuse_namespace_from_config() {
  if [ -n "${CLOUDFLARE_STATE_NAMESPACE:-}" ]; then
    return 1
  fi
  if [ ! -f "$CONFIG_PATH" ]; then
    return 1
  fi
  existing_id=$(
    python3 "$HELPERS_PATH" wrangler-toml "$CONFIG_PATH" 2>/dev/null || true
  )
  if [ -n "$existing_id" ]; then
    CLOUDFLARE_STATE_NAMESPACE="$existing_id"
    export CLOUDFLARE_STATE_NAMESPACE
    echo "Reusing STATE namespace id from wrangler.toml: $CLOUDFLARE_STATE_NAMESPACE"
    return 0
  fi
  return 1
}

if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  echo "CLOUDFLARE_ACCOUNT_ID is required for Wrangler operations." >&2
  exit 1
fi

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "CLOUDFLARE_API_TOKEN is required for Wrangler operations." >&2
  exit 1
fi

# Helper to discover namespace ID via Wrangler CLI
discover_namespace_id() {
  if list_json=$(uv run -- pywrangler kv namespace list 2>/dev/null); then
    printf '%s' "$list_json" | python3 "$HELPERS_PATH" namespace-list "$STATE_NAMESPACE_NAME" || true
  fi
}

# Ensure we know the namespace ID (reuse existing or create if missing)
ensure_namespace() {
  if [ -n "${CLOUDFLARE_STATE_NAMESPACE:-}" ]; then
    echo "STATE namespace already set: $CLOUDFLARE_STATE_NAMESPACE"
    return
  fi

  if reuse_namespace_from_config; then
    return
  fi

  existing_id=$(discover_namespace_id)
  if [ -n "$existing_id" ]; then
    CLOUDFLARE_STATE_NAMESPACE="$existing_id"
    export CLOUDFLARE_STATE_NAMESPACE
    echo "Found existing STATE namespace id: $CLOUDFLARE_STATE_NAMESPACE"
    return
  fi

  echo "Creating STATE namespace \"$STATE_NAMESPACE_NAME\" via pywrangler ..."
  if ! output=$(uv run -- pywrangler kv namespace create "$STATE_NAMESPACE_NAME" 2>&1); then
    echo "$output"
    if echo "$output" | grep -q "already exists"; then
      echo "Namespace already exists; attempting to discover its ID..."
      existing_id=$(discover_namespace_id)
      if [ -z "$existing_id" ]; then
        echo "Unable to discover namespace id automatically; please set CLOUDFLARE_STATE_NAMESPACE manually."
        exit 1
      fi
      CLOUDFLARE_STATE_NAMESPACE="$existing_id"
      export CLOUDFLARE_STATE_NAMESPACE
      echo "Found existing namespace id: $CLOUDFLARE_STATE_NAMESPACE"
      return
    fi
    exit 1
  fi
  CLOUDFLARE_STATE_NAMESPACE=$(
    printf "%s\n" "$output" | python3 "$HELPERS_PATH" namespace-create || true
  )
  if [ -z "$CLOUDFLARE_STATE_NAMESPACE" ]; then
    echo "Unable to parse namespace id. Please set CLOUDFLARE_STATE_NAMESPACE manually."
    exit 1
  fi
  export CLOUDFLARE_STATE_NAMESPACE
}

ensure_namespace
if [ ! -f "$TEMPLATE_PATH" ]; then
  echo "Missing wrangler template at $TEMPLATE_PATH" >&2
  exit 1
fi

if command -v envsubst >/dev/null 2>&1; then
  CLOUDFLARE_STATE_NAMESPACE="$CLOUDFLARE_STATE_NAMESPACE" envsubst < "$TEMPLATE_PATH" > "$CONFIG_PATH"
else
  sed "s/\${CLOUDFLARE_STATE_NAMESPACE}/$CLOUDFLARE_STATE_NAMESPACE/g" "$TEMPLATE_PATH" > "$CONFIG_PATH"
fi
echo "Generated wrangler.toml with STATE namespace id: $CLOUDFLARE_STATE_NAMESPACE"

# Namespace ensured above (created if missing)
echo "STATE namespace title: $STATE_NAMESPACE_NAME"
echo "STATE namespace id: $CLOUDFLARE_STATE_NAMESPACE"

echo "Setting up secrets..."
printf "%s" "${APPLE_ID:?APPLE_ID must be set}" | uv run -- pywrangler secret put APPLE_ID
printf "%s" "${APPLE_APP_PASSWORD:?APPLE_APP_PASSWORD must be set}" | uv run -- pywrangler secret put APPLE_APP_PASSWORD
printf "%s" "${NOTION_TOKEN:?NOTION_TOKEN must be set}" | uv run -- pywrangler secret put NOTION_TOKEN
printf "%s" "${ADMIN_TOKEN:?ADMIN_TOKEN must be set}" | uv run -- pywrangler secret put ADMIN_TOKEN

# Deploy the Worker (creates notion-caldav-sync if missing)
uv run -- pywrangler deploy --name notion-caldav-sync

echo "Deployment complete."
echo "Visit your worker URL and trigger /webhook/notion or wait for cron to initialize calendars."
echo "Notes: Bi-directional sync is now enabled. CalDAV delta polling (RFC6578 sync token + ETag) is stored in KV as caldav_rfc6578_token; a stale token auto-falls back to full fetch. Mapping + indexes live in STATE KV; webhook verification token is persisted automatically."
