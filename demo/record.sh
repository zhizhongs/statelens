#!/usr/bin/env bash
# End-to-end demo script for screen recording.
#
# Walks through: install check -> boot proxy -> run agent direct -> run agent
# through proxy -> show savings table. Paced with `read -p` so you control the
# cadence while recording. Use ENTER to advance between sections.
#
# Prereqs:
#   - statelens-sdk installed globally (or symlinked via `npm link`)
#   - ANTHROPIC_API_KEY exported (or in .env at repo root)
#   - `npm run build` has been run (the demo uses dist/ via tsx)
#
# Usage:
#   bash demo/record.sh
#
# Skip pauses for a smoke test:
#   DEMO_NO_PAUSE=1 bash demo/record.sh

set -euo pipefail

# Always run from repo root so `dist/demo/run_demo.js` resolves correctly
# regardless of where the script is invoked from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

PORT=8443
PROXY_LOG=/tmp/statelens-demo-proxy.log
DIRECT_LOG=/tmp/statelens-demo-direct.log
PROXIED_LOG=/tmp/statelens-demo-proxied.log

# Colors
BOLD=$'\033[1m'
DIM=$'\033[2m'
YELLOW=$'\033[33m'
GREEN=$'\033[32m'
CYAN=$'\033[36m'
RESET=$'\033[0m'

pause() {
  if [[ -z "${DEMO_NO_PAUSE:-}" ]]; then
    read -r -p "${DIM}↵ continue${RESET}"
  fi
}

cleanup() {
  if [[ -n "${PROXY_PID:-}" ]] && kill -0 "$PROXY_PID" 2>/dev/null; then
    kill "$PROXY_PID" 2>/dev/null || true
    wait "$PROXY_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

clear
cat <<EOF
${BOLD}StateLens — end-to-end demo${RESET}

Watch a real Anthropic SDK agent reduce input tokens by ~50% with a
single env-var change. No code modifications.

EOF
pause

# ------------------------------------------------------------------------
# Step 1 — install check
# ------------------------------------------------------------------------
echo "${BOLD}1. Install${RESET}"
echo "${DIM}\$ npm install -g statelens-sdk${RESET}"
echo ""
if ! command -v statelens >/dev/null 2>&1; then
  echo "  ${YELLOW}statelens binary not found on PATH.${RESET}"
  echo "  Run: npm install -g statelens-sdk"
  exit 1
fi
installed_version=$(npm ls -g statelens-sdk --depth=0 2>/dev/null | sed -n 's/.*statelens-sdk@\([0-9.]*\).*/\1/p' | head -1)
echo "  ${GREEN}✓${RESET} statelens-sdk@${installed_version:-installed} on PATH"
echo ""
pause

# ------------------------------------------------------------------------
# Step 2 — boot the proxy
# ------------------------------------------------------------------------
echo "${BOLD}2. Start the proxy${RESET}"
echo "${DIM}\$ statelens proxy --provider anthropic --port ${PORT}${RESET}"
echo ""
statelens proxy --provider anthropic --port "$PORT" >"$PROXY_LOG" 2>&1 &
PROXY_PID=$!

# Wait for /health
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.2
done

echo "${DIM}\$ curl http://127.0.0.1:${PORT}/health${RESET}"
curl -s "http://127.0.0.1:${PORT}/health"
echo ""
echo ""
echo "  proxy pid: $PROXY_PID  (log: $PROXY_LOG)"
echo ""
pause

# ------------------------------------------------------------------------
# Step 3 — run the agent direct
# ------------------------------------------------------------------------
echo "${BOLD}3. Run the agent — direct to api.anthropic.com${RESET}"
echo "${DIM}\$ unset ANTHROPIC_BASE_URL && node dist/demo/run_demo.js${RESET}"
echo ""
( unset ANTHROPIC_BASE_URL && node dist/demo/run_demo.js ) | tee "$DIRECT_LOG"
echo ""
pause

# ------------------------------------------------------------------------
# Step 4 — run the agent through the proxy
# ------------------------------------------------------------------------
echo "${BOLD}4. Run the SAME agent — only ANTHROPIC_BASE_URL changes${RESET}"
echo "${DIM}\$ export ANTHROPIC_BASE_URL=http://127.0.0.1:${PORT}${RESET}"
echo "${DIM}\$ node dist/demo/run_demo.js${RESET}"
echo ""
ANTHROPIC_BASE_URL="http://127.0.0.1:${PORT}" node dist/demo/run_demo.js | tee "$PROXIED_LOG"
echo ""
pause

# ------------------------------------------------------------------------
# Step 5 — savings table
# ------------------------------------------------------------------------
direct_line=$(grep STATELENS_DEMO_RESULT "$DIRECT_LOG")
proxied_line=$(grep STATELENS_DEMO_RESULT "$PROXIED_LOG")

direct_in=$(echo "$direct_line" | sed -n 's/.*input=\([0-9]*\).*/\1/p')
direct_cost=$(echo "$direct_line" | sed -n 's/.*cost=\([0-9.]*\).*/\1/p')
proxied_in=$(echo "$proxied_line" | sed -n 's/.*input=\([0-9]*\).*/\1/p')
proxied_cost=$(echo "$proxied_line" | sed -n 's/.*cost=\([0-9.]*\).*/\1/p')

token_reduction=$(awk "BEGIN{ if($direct_in>0) printf \"%.1f\", ($direct_in-$proxied_in)/$direct_in*100; else print 0 }")
cost_reduction=$(awk "BEGIN{ if($direct_cost>0) printf \"%.1f\", ($direct_cost-$proxied_cost)/$direct_cost*100; else print 0 }")

echo "${BOLD}${CYAN}5. Result${RESET}"
echo ""
printf "  %-22s %15s %15s\n" "" "direct" "via proxy"
printf "  %-22s %15s %15s\n" "input tokens" "$direct_in" "$proxied_in"
printf "  %-22s %15s %15s\n" "cost (USD)" "\$${direct_cost}" "\$${proxied_cost}"
echo ""
echo "  ${BOLD}${GREEN}token reduction: ${token_reduction}%${RESET}"
echo "  ${BOLD}${GREEN}cost  reduction: ${cost_reduction}%${RESET}"
echo ""
echo "  Same agent code. Same screenshots. Same model. One env var."
echo ""
echo "  ${DIM}npm install -g statelens-sdk${RESET}"
echo ""
