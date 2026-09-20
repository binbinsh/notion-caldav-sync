#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$SCRIPT_DIR"
CONFIG_PATH="$ROOT_DIR/wrangler.toml"
HOSTED_TEMPLATE_PATH="$ROOT_DIR/wrangler.toml-example"
PERSONAL_TEMPLATE_PATH="$ROOT_DIR/wrangler.personal.toml-example"
HELPERS_PATH="$ROOT_DIR/scripts/deploy_helpers.py"
ENV_LOADER_PATH="$ROOT_DIR/scripts/load-env.sh"
STATE_NAMESPACE_NAME="notion-caldav-sync-STATE"  # Change if you prefer a different namespace title.
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"

cd "$ROOT_DIR"

# shellcheck disable=SC1090
source "$ENV_LOADER_PATH"
load_env_file "$ENV_FILE"

if ! command -v npx >/dev/null 2>&1; then
  if command -v mise >/dev/null 2>&1; then
    NODE_RUNTIME_DIR="$(mise where node@24.21.0 2>/dev/null || true)/bin"
    if [ ! -x "$NODE_RUNTIME_DIR/npx" ]; then
      echo "Node.js is not ready. Run ./scripts/setup-cloudflare.sh to install the pinned runtime." >&2
      exit 1
    fi
    export PATH="$NODE_RUNTIME_DIR:$PATH"
  else
    echo "Node.js with npx is required. Alternatively, install mise and run ./scripts/setup-cloudflare.sh." >&2
    exit 1
  fi
fi

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
    STATUS_EMOJI_STYLE="emoji"
    export STATUS_EMOJI_STYLE
    echo "Using default STATUS_EMOJI_STYLE=$STATUS_EMOJI_STYLE"
    return
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

choose_worker_endpoint() {
  local domain=${WORKER_CUSTOM_DOMAIN:-}
  domain=$(printf "%s" "$domain" | tr '[:upper:]' '[:lower:]' | xargs)

  if [ -z "$domain" ] && [ -t 0 ] && [ "${WORKER_ENDPOINT_CONFIGURED:-}" != "1" ]; then
    read -r -p "Worker custom domain (optional; press Enter for workers.dev): " domain
    domain=$(printf "%s" "$domain" | tr '[:upper:]' '[:lower:]' | xargs)
  fi

  if [ -z "$domain" ]; then
    WORKER_CUSTOM_DOMAIN=""
    WORKERS_DEV=true
    export WORKER_CUSTOM_DOMAIN WORKERS_DEV
    echo "Using the free workers.dev hostname assigned by Cloudflare."
    return
  fi
  if [[ ! "$domain" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$ ]]; then
    echo "Invalid WORKER_CUSTOM_DOMAIN=$domain (expected a hostname without scheme or path)." >&2
    exit 1
  fi

  WORKER_CUSTOM_DOMAIN="$domain"
  WORKERS_DEV=false
  export WORKER_CUSTOM_DOMAIN WORKERS_DEV
  echo "Using custom domain: $WORKER_CUSTOM_DOMAIN"
}

require_hosted_config() {
  local required=(
    CLOUDFLARE_D1_DATABASE_ID CLOUDFLARE_SYNC_QUEUE CLOUDFLARE_SYNC_DLQ
    PUBLIC_BASE_URL NOTION_CLIENT_ID CLERK_PUBLISHABLE_KEY CLERK_JWKS_URL
    CLERK_SIGN_IN_URL CLERK_AUTHORIZED_PARTIES HOSTED_SYNC_INTERVAL_MINUTES
    HOSTED_CRON_BATCH_LIMIT HOSTED_BETA_USER_LIMIT HOSTED_ADMIN_USER_IDS
  )
  local key
  for key in "${required[@]}"; do
    if [ -z "${!key:-}" ]; then
      echo "$key is required for hosted multi-user deployment." >&2
      exit 1
    fi
  done
}

reuse_namespace_from_config() {
  if [ -n "${CLOUDFLARE_STATE_NAMESPACE:-}" ]; then
    return 1
  fi
  if [ ! -f "$CONFIG_PATH" ]; then
    return 1
  fi
  existing_id=$(
    uv run python "$HELPERS_PATH" wrangler-toml "$CONFIG_PATH" 2>/dev/null || true
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

if ! uv run -- pywrangler whoami >/dev/null 2>&1; then
  echo "Cloudflare authentication is required." >&2
  echo "Run 'uv run pywrangler login' for OAuth, or set CLOUDFLARE_API_TOKEN for headless deployment." >&2
  exit 1
fi

# Helper to discover namespace ID via Wrangler CLI
discover_namespace_id() {
  if list_json=$(uv run -- pywrangler kv namespace list 2>/dev/null); then
    printf '%s' "$list_json" | uv run python "$HELPERS_PATH" namespace-list "$STATE_NAMESPACE_NAME" || true
  fi
}

namespace_exists() {
  local namespace_id=${1:-}
  if list_json=$(uv run -- pywrangler kv namespace list 2>/dev/null); then
    if printf '%s' "$list_json" | uv run python "$HELPERS_PATH" namespace-exists "$namespace_id" >/dev/null; then
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
    printf "%s\n" "$output" | uv run python "$HELPERS_PATH" namespace-create || true
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
choose_worker_endpoint
DEPLOYMENT_MODE=${DEPLOYMENT_MODE:-}
if [ -z "$DEPLOYMENT_MODE" ]; then
  if [ -n "${CLOUDFLARE_D1_DATABASE_ID:-}" ]; then
    DEPLOYMENT_MODE=hosted
  else
    DEPLOYMENT_MODE=personal
  fi
fi
case "$DEPLOYMENT_MODE" in
  personal)
    TEMPLATE_PATH="$PERSONAL_TEMPLATE_PATH"
    for key in NOTION_TOKEN APPLE_ID APPLE_APP_PASSWORD ADMIN_TOKEN WEBHOOK_SETUP_TOKEN; do
      if [ -z "${!key:-}" ]; then
        echo "$key is required for personal deployment." >&2
        exit 1
      fi
    done
    ;;
  hosted)
    TEMPLATE_PATH="$HOSTED_TEMPLATE_PATH"
    require_hosted_config
    ;;
  *)
    echo "DEPLOYMENT_MODE must be personal or hosted." >&2
    exit 1
    ;;
esac
if [ ! -f "$TEMPLATE_PATH" ]; then
  echo "Missing wrangler template at $TEMPLATE_PATH" >&2
  exit 1
fi

uv run python "$HELPERS_PATH" render-template "$TEMPLATE_PATH" > "$CONFIG_PATH"
if [ -n "$WORKER_CUSTOM_DOMAIN" ]; then
  cat >> "$CONFIG_PATH" <<EOF

[[routes]]
pattern = "$WORKER_CUSTOM_DOMAIN"
custom_domain = true
EOF
fi
echo "Generated wrangler.toml with STATE namespace id: $CLOUDFLARE_STATE_NAMESPACE"

# Namespace ensured above (created if missing)
echo "STATE namespace title: $STATE_NAMESPACE_NAME"
echo "STATE namespace id: $CLOUDFLARE_STATE_NAMESPACE"

echo "Setting up secrets..."
REMOTE_SECRETS=$(uv run -- pywrangler secret list --name notion-caldav-sync --format json 2>/dev/null || printf '[]')

remote_secret_exists() {
  local key="$1"
  printf '%s' "$REMOTE_SECRETS" | uv run python "$HELPERS_PATH" secret-exists "$key" >/dev/null
}

put_secret_if_present() {
  local key="$1"
  if [ -n "${!key:-}" ]; then
    printf "%s" "${!key}" | uv run -- pywrangler secret put "$key"
  elif remote_secret_exists "$key"; then
    echo "Reusing existing Worker secret: $key"
  else
    echo "$key is not set locally and does not exist on the Worker." >&2
    exit 1
  fi
}

if [ "$DEPLOYMENT_MODE" = "personal" ]; then
  put_secret_if_present APPLE_ID
  put_secret_if_present APPLE_APP_PASSWORD
  put_secret_if_present NOTION_TOKEN
  put_secret_if_present ADMIN_TOKEN
  put_secret_if_present WEBHOOK_SETUP_TOKEN
else
  put_secret_if_present NOTION_CLIENT_SECRET
  put_secret_if_present CREDENTIAL_VAULT_KEY
  put_secret_if_present HOSTED_WEBHOOK_SETUP_TOKEN
  npx --yes wrangler d1 migrations apply notion-caldav-sync --remote --config "$CONFIG_PATH"
fi

# Deploy the Worker (creates notion-caldav-sync if missing).
DEPLOY_LOG=$(mktemp)
cleanup_deploy_log() { rm -f "$DEPLOY_LOG"; }
trap cleanup_deploy_log EXIT
uv run -- pywrangler deploy --name notion-caldav-sync | tee "$DEPLOY_LOG"

if [ -n "$WORKER_CUSTOM_DOMAIN" ]; then
  WORKER_URL="https://$WORKER_CUSTOM_DOMAIN"
else
  WORKER_URL=$(grep -Eo 'https://[a-zA-Z0-9.-]+\.workers\.dev' "$DEPLOY_LOG" | tail -n1 || true)
  if [ -z "$WORKER_URL" ] && [[ "${PUBLIC_BASE_URL:-}" == https://*.workers.dev ]]; then
    WORKER_URL="${PUBLIC_BASE_URL%/}"
  fi
fi

echo "Deployment complete."
echo "Deployment mode: $DEPLOYMENT_MODE"
if [ -n "$WORKER_URL" ]; then
  echo "Worker URL: $WORKER_URL"
  if [ "$DEPLOYMENT_MODE" = "hosted" ]; then
    echo "Webhook URL: ${WORKER_URL%/}/webhook/notion/hosted?setup=<HOSTED_WEBHOOK_SETUP_TOKEN>"
  else
    echo "Webhook URL: ${WORKER_URL%/}/webhook/notion"
  fi
else
  echo "Worker URL: check the deploy output above or Cloudflare Workers & Pages."
fi
