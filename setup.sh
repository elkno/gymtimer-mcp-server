#!/usr/bin/env bash
#
# One-command install for the GymTimer workout MCP server.
#
#   ./setup.sh
#
# Run it once per computer. It installs and builds the server, walks you
# through the two CloudKit tokens, saves which CloudKit environment your
# data lives in, registers the server with Cursor, and finishes with a
# health check. No Xcode, no CloudKit Console access, no Apple Developer
# membership needed - just Node.js and your own Apple ID.
#
set -euo pipefail
cd "$(dirname "$0")"
SERVER_DIR="$(pwd)"
CONFIG_DIR="${GYMTIMER_CONFIG_DIR:-$HOME/.config/gymtimer}"
ENTRY_POINT="$SERVER_DIR/dist/index.js"

echo "==> 1/6 Checking prerequisites"
if ! command -v node >/dev/null 2>&1; then
  echo "  ! Node.js not found. Install it first (https://nodejs.org, or 'brew install node'), then re-run this script." >&2
  exit 1
fi
node_major="$(node --version | sed 's/^v//' | cut -d. -f1)"
if (( node_major < 18 )); then
  echo "  ! Node.js $(node --version) is too old - version 18 or newer is required." >&2
  exit 1
fi
echo "  - node $(node --version)"

echo
echo "==> 2/6 Installing dependencies and building"
npm install
npm run build
echo "  - built $ENTRY_POINT"

echo
echo "==> 3/6 CloudKit API token"
echo "  This identifies the GymTimer app to CloudKit. The app owner shares one"
echo "  with everybody - it grants no access to anyone's workout data on its own."
mkdir -p "$CONFIG_DIR"
if [[ -f "$CONFIG_DIR/ck-api-token" ]]; then
  echo "  - already saved at $CONFIG_DIR/ck-api-token (delete that file to re-enter it)"
else
  echo "  Paste the API token below, then press Enter (nothing will appear as you type):"
  read -r -s token
  token="$(printf '%s' "$token" | tr -d '[:space:]')"
  if [[ -z "$token" ]]; then
    echo "  ! Nothing entered - stopping here. Re-run ./setup.sh once you have the token." >&2
    exit 1
  fi
  printf '%s' "$token" > "$CONFIG_DIR/ck-api-token"
  chmod 600 "$CONFIG_DIR/ck-api-token"
  unset token
  echo "  - saved to $CONFIG_DIR/ck-api-token"
fi

echo
echo "==> 4/6 Which CloudKit environment holds your data?"
echo "  - production:  you installed GymTimer from TestFlight or the App Store (most people)"
echo "  - development: you run GymTimer from Xcode yourself"
saved_environment=""
[[ -f "$CONFIG_DIR/environment" ]] && saved_environment="$(tr -d '[:space:]' < "$CONFIG_DIR/environment")"
default_environment="${saved_environment:-production}"
read -r -p "  Which one? [production/development] (default: $default_environment) " environment
environment="${environment:-$default_environment}"
if [[ "$environment" != "development" && "$environment" != "production" ]]; then
  echo "  ! Unrecognized value \"$environment\" - using production instead." >&2
  environment="production"
fi
printf '%s' "$environment" > "$CONFIG_DIR/environment"
echo "  - using $environment (saved to $CONFIG_DIR/environment)"

echo
echo "==> 5/6 Signing in with your Apple ID"
echo "  This is what makes the server see YOUR workouts and nobody else's."
echo "  It opens a browser sign-in; use the same Apple ID as your iPhone/Watch."
if [[ -f "$CONFIG_DIR/ck-web-auth-token" ]]; then
  read -r -p "  You already have a saved sign-in. Sign in again anyway? [y/N] " answer
else
  answer="y"
fi
if [[ "$answer" =~ ^[Yy]$ ]]; then
  GYMTIMER_CK_ENVIRONMENT="$environment" npm run --silent get-web-auth-token
else
  echo "  - keeping the existing token"
fi

echo
echo "==> 6/6 Registering the server with Cursor"
node scripts/write-mcp-config.mjs "$HOME/.cursor/mcp.json" "$ENTRY_POINT" "$environment"

echo
echo "==> Health check"
set +e
npm run --silent doctor
doctor_status=$?
set -e

echo "==> Next steps"
echo
echo "  1. Restart Cursor so it launches the server (Settings -> MCP should show a green dot)."
echo
echo "  2. Using Claude Code, Claude Desktop, VS Code or another AI app instead?"
echo "     Claude Code, in one command:"
echo
echo "       claude mcp add gymtimer -e GYMTIMER_CK_ENVIRONMENT=$environment -- node $ENTRY_POINT"
echo
echo "     Everything else: see CLIENT-SETUP.md for copy-paste config per app."
echo
echo "  3. Then just ask: \"show my last 7 days of training\"."
echo
if (( doctor_status != 0 )); then
  echo "  Note: the health check above reported problems - fix those first."
  echo "  You can re-run it any time with: npm run doctor"
  exit $doctor_status
fi
echo "  Later, if a tool call fails with an authentication error, run: ./refresh-tokens.sh"
