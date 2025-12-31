#!/bin/bash
set -euo pipefail


export STATUS_EMOJI_STYLE="symbol"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$SCRIPT_DIR"
CONFIG_PATH="$ROOT_DIR/wrangler.toml"
TEMPLATE_PATH="$ROOT_DIR/wrangler.toml-example"
HELPERS_PATH="$ROOT_DIR/scripts/deploy_helpers.py"
STATE_NAMESPACE_NAME="notion-caldav-sync-STATE"  # Change if you prefer a different namespace title.

source $ROOT_DIR/.env

cd "$ROOT_DIR"

resolve_status_emoji_style() {
  local style=${1:-}
  style=$(printf "%s" "$style" | tr '[:upper:]' '[:lower:]' | xargs)
  case "$style" in
    "") echo "emoji" ;;
    emoji|symbol) echo "$style" ;;
    *)
      echo "Invalid STATUS_EMOJI_STYLE=$style (expected: emoji|symbol)" >&2
      return 1
      ;;
  esac
}

choose_status_emoji_style() {
  if [ -n "${STATUS_EMOJI_STYLE:-}" ]; then
    if ! STATUS_EMOJI_STYLE=$(resolve_status_emoji_style "$STATUS_EMOJI_STYLE"); then
      exit 1
    fi
    export STATUS_EMOJI_STYLE
    echo "Using STATUS_EMOJI_STYLE=$STATUS_EMOJI_STYLE"
    return
  fi

  if [ ! -t 0 ]; then
    echo "STATUS_EMOJI_STYLE is required in non-interactive mode (set: emoji|symbol)." >&2
    exit 1
  fi

  echo "Choose status emoji style:"
  echo "  1) emoji   (⬜ ⚙️ ✅ ⚠️ ❌)"
  echo "  2) symbol  (○ ⊖ ✓⃝ ⊜ ⊗)"
  while true; do
    read -r -p "Selection [1|2]: " choice
    case "${choice:-}" in
      1) STATUS_EMOJI_STYLE="emoji" ;;
      2) STATUS_EMOJI_STYLE="symbol" ;;
      *)
        echo "Invalid selection; enter 1 or 2." >&2
        continue
        ;;
    esac
    break
  done
  export STATUS_EMOJI_STYLE
  echo "Using STATUS_EMOJI_STYLE=$STATUS_EMOJI_STYLE"
}

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
    if namespace_exists "$existing_id"; then
      CLOUDFLARE_STATE_NAMESPACE="$existing_id"
      export CLOUDFLARE_STATE_NAMESPACE
      echo "Reusing STATE namespace id from wrangler.toml: $CLOUDFLARE_STATE_NAMESPACE"
      return 0
    fi
    echo "STATE namespace id in wrangler.toml is missing from the account; will create a fresh one."
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

namespace_exists() {
  local namespace_id=${1:-}
  if list_json=$(uv run -- pywrangler kv namespace list 2>/dev/null); then
    if printf '%s' "$list_json" | python3 "$HELPERS_PATH" namespace-exists "$namespace_id" >/dev/null; then
      return 0
    fi
  fi
  return 1
}

# Ensure we know the namespace ID (reuse existing or create if missing)
ensure_namespace() {
  if [ -n "${CLOUDFLARE_STATE_NAMESPACE:-}" ]; then
    echo "STATE namespace already set: $CLOUDFLARE_STATE_NAMESPACE"
    if namespace_exists "$CLOUDFLARE_STATE_NAMESPACE"; then
      return
    fi
    echo "STATE namespace id does not exist in the account; creating a new namespace..."
    unset CLOUDFLARE_STATE_NAMESPACE
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
  if output=$(uv run -- pywrangler kv namespace create "$STATE_NAMESPACE_NAME" 2>&1); then
    :
  else
    create_status=$?
  fi
  if echo "$output" | grep -qi "already exists"; then
    echo "$output"
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
  if [ "${create_status:-0}" -ne 0 ]; then
    echo "$output"
    exit 1
  fi
  CLOUDFLARE_STATE_NAMESPACE=$(
    printf "%s\n" "$output" | python3 "$HELPERS_PATH" namespace-create || true
  )
  if [ -z "$CLOUDFLARE_STATE_NAMESPACE" ]; then
    echo "$output"
    echo "Unable to parse namespace id. Please set CLOUDFLARE_STATE_NAMESPACE manually."
    exit 1
  fi
  export CLOUDFLARE_STATE_NAMESPACE
}

ensure_namespace
choose_status_emoji_style
if [ ! -f "$TEMPLATE_PATH" ]; then
  echo "Missing wrangler template at $TEMPLATE_PATH" >&2
  exit 1
fi

if command -v envsubst >/dev/null 2>&1; then
  CLOUDFLARE_STATE_NAMESPACE="$CLOUDFLARE_STATE_NAMESPACE" STATUS_EMOJI_STYLE="$STATUS_EMOJI_STYLE" envsubst < "$TEMPLATE_PATH" > "$CONFIG_PATH"
else
  sed \
    -e "s/\${CLOUDFLARE_STATE_NAMESPACE}/$CLOUDFLARE_STATE_NAMESPACE/g" \
    -e "s/\${STATUS_EMOJI_STYLE}/$STATUS_EMOJI_STYLE/g" \
    "$TEMPLATE_PATH" > "$CONFIG_PATH"
fi
echo "Generated wrangler.toml with STATE namespace id: $CLOUDFLARE_STATE_NAMESPACE"

# Namespace ensured above (created if missing)
echo "STATE namespace title: $STATE_NAMESPACE_NAME"
echo "STATE namespace id: $CLOUDFLARE_STATE_NAMESPACE"

# Bootstrap Notion Configuration
echo "Bootstrapping Notion Configuration..."
CONFIG_DB_ID=$(uv run python scripts/bootstrap_notion.py)

if [ -n "$CONFIG_DB_ID" ]; then
    echo "Caching Config ID to KV ($CONFIG_DB_ID)..."
    # We use pywrangler (wrapper around wrangler) to put the key
    # Value must be properly JSON encoded/quoted for the settings store
    npx --yes wrangler kv key put --namespace-id "$CLOUDFLARE_STATE_NAMESPACE" "settings:value:config_db_id" "\"$CONFIG_DB_ID\"" --remote
fi

echo "Setting up secrets..."
printf "%s" "${APPLE_ID:?APPLE_ID must be set}" | uv run -- pywrangler secret put APPLE_ID
printf "%s" "${APPLE_APP_PASSWORD:?APPLE_APP_PASSWORD must be set}" | uv run -- pywrangler secret put APPLE_APP_PASSWORD
printf "%s" "${NOTION_TOKEN:?NOTION_TOKEN must be set}" | uv run -- pywrangler secret put NOTION_TOKEN
printf "%s" "${ADMIN_TOKEN:?ADMIN_TOKEN must be set}" | uv run -- pywrangler secret put ADMIN_TOKEN

# Deploy the Worker (creates notion-caldav-sync if missing)
uv run -- pywrangler deploy --name notion-caldav-sync

echo "Deployment complete."
echo "Visit your worker URL and trigger /webhook/notion or wait for cron to initialize calendars."
