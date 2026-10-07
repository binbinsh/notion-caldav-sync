#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
config="${WRANGLER_CONFIG:-wrangler.local.jsonc}"
test -f "$config" || { echo "Copy wrangler.jsonc to wrangler.local.jsonc and configure sources/calendar first." >&2; exit 1; }
pnpm check
pnpm exec wrangler deploy --config "$config" --dry-run --outdir dist
pnpm exec wrangler deploy --config "$config"
