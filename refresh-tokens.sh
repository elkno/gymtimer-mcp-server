#!/usr/bin/env bash
#
# Refresh the CloudKit token(s) this MCP server authenticates with.
#
#   ./refresh-tokens.sh              # refresh the web auth token - the one that expires (the common case)
#   ./refresh-tokens.sh --api-token  # also replace the one-time API token (rare - only if the app owner issued a new one)
#
# The web auth token is tied to a specific CloudKit environment, so this
# script deliberately does NOT pick one of its own: it reads the same
# environment the server uses (scripts/config.mjs - GYMTIMER_CK_ENVIRONMENT,
# else ~/.config/gymtimer/environment, else production). Minting a token for
# the wrong environment produces an error identical to an expired token.
#
set -euo pipefail
cd "$(dirname "$0")"

CONFIG_DIR="${GYMTIMER_CONFIG_DIR:-$HOME/.config/gymtimer}"
mkdir -p "$CONFIG_DIR"

replace_api_token=false
[[ "${1:-}" == "--api-token" ]] && replace_api_token=true

if $replace_api_token; then
  echo "== CloudKit API token =="
  echo "Ask the app owner for a fresh CloudKit Web Services API Token."
  echo "(Owners: CloudKit Console -> CloudKit Database -> pick the container, switch the"
  echo " environment selector to Production -> Settings -> Tokens & Keys -> new API Token,"
  echo " with Sign in Callback set to URL Redirect. Full steps are in README.md."
  echo " It's a long hex string, NOT the User or Management token.)"
  while :; do
    echo "Paste the new API token, then press Enter:"
    read -r -s token
    token="$(printf '%s' "$token" | tr -d '[:space:]')"
    if [[ "$token" =~ ^[0-9a-fA-F]{40,}$ ]]; then
      printf '%s' "$token" > "$CONFIG_DIR/ck-api-token"
      chmod 600 "$CONFIG_DIR/ck-api-token"
      unset token
      echo "Saved to $CONFIG_DIR/ck-api-token"
      break
    fi
    echo "! That doesn't look like a hex API token (got ${#token} chars). Try again, or press Ctrl-C to abort."
    unset token
  done
  echo
fi

echo "== Web auth token (this is the one that expires) =="
npm run --silent get-web-auth-token

echo
echo "Done. Now restart your MCP client so it picks up the new token:"
echo "  - Cursor: restart it, or use the refresh icon in Settings -> MCP"
echo "  - Claude Code: run /mcp"
echo "  - Claude Desktop: fully quit and reopen the app"
echo
echo "Then run 'npm run doctor' to confirm everything passes."
