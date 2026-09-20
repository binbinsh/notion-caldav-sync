#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"

if [ ! -f "$ENV_FILE" ]; then
  echo "Missing $ENV_FILE. Run ./scripts/setup-cloudflare.sh first." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

PUBLIC_BASE_URL=${PUBLIC_BASE_URL:-}
HOSTED_WEBHOOK_SETUP_TOKEN=${HOSTED_WEBHOOK_SETUP_TOKEN:-}
if [ -z "$PUBLIC_BASE_URL" ] || [ -z "$HOSTED_WEBHOOK_SETUP_TOKEN" ]; then
  echo "PUBLIC_BASE_URL and HOSTED_WEBHOOK_SETUP_TOKEN are required." >&2
  exit 1
fi

open_url() {
  local url="$1"
  if command -v open >/dev/null 2>&1; then
    open "$url"
  elif command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$url" >/dev/null 2>&1 &
  fi
}

WEBHOOK_URL="${PUBLIC_BASE_URL%/}/webhook/notion/hosted?setup=${HOSTED_WEBHOOK_SETUP_TOKEN}"
STATUS_URL="${PUBLIC_BASE_URL%/}/api/webhook/setup?setup=${HOSTED_WEBHOOK_SETUP_TOKEN}"

echo
echo "Notion webhook setup"
echo "===================="
echo "This is the only hosted deployment step that Notion does not expose through an API."
echo
echo "1. Open the Public Connection used by this service."
echo "2. Create a webhook subscription with this URL:"
echo "   $WEBHOOK_URL"
echo "3. Subscribe to Page, Database, and Data source events."
echo
open_url "https://www.notion.so/profile/integrations"
read -r -p "Press Enter after Notion sends the verification request... "

response_file=$(mktemp)
trap 'rm -f "$response_file"' EXIT
status=$(curl --silent --show-error --output "$response_file" --write-out '%{http_code}' "$STATUS_URL")
if [ "$status" != "200" ]; then
  echo "The Worker has not received the verification request yet (HTTP $status)." >&2
  echo "Check the webhook URL in Notion, then run this command again." >&2
  exit 1
fi

verification_token=$(python3 - "$response_file" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    print(json.load(handle).get("verification_token", ""))
PY
)
if [ -z "$verification_token" ]; then
  echo "The Worker returned no verification token." >&2
  exit 1
fi

echo
echo "4. Paste this verification token into Notion:"
echo "   $verification_token"
echo
read -r -p "Press Enter after Notion reports the subscription as active... "
echo "Webhook setup complete."
