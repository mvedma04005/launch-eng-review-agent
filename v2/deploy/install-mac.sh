#!/usr/bin/env bash
# Installs the daemon as a launchd agent for the current (dedicated) user. Idempotent.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
STATE="${FALCON_STATE_DIR:-$HOME/Library/Application Support/falcon}"
CONF_DIR="$HOME/.config/falcon"
LABEL=com.rokt.falcon
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

command -v node >/dev/null || { echo "node 22.18+ is required (brew install node@22)"; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)' || { echo "node $(node --version) is too old; need 22.18+"; exit 1; }
command -v git >/dev/null || { echo "git is required"; exit 1; }

mkdir -p "$STATE/logs" "$CONF_DIR" "$HOME/Library/LaunchAgents"
chmod 700 "$STATE" "$CONF_DIR"
[ -f "$CONF_DIR/env" ] || { umask 077; cat > "$CONF_DIR/env" <<'ENV'
# Secrets for the Falcon review engine. Mode 600. Never commit.
ANTHROPIC_API_KEY=
FALCON_GITHUB_PRIVATE_KEY=
# Optional: Google Chat or Slack incoming webhook for alerts.
FALCON_NOTIFY_WEBHOOK=
ENV
echo "wrote $CONF_DIR/env; fill in the secrets before starting"; }
chmod 600 "$CONF_DIR/env"
[ -f "$CONF_DIR/falcon.yaml" ] || cat > "$CONF_DIR/falcon.yaml" <<YAML
stateDir: $STATE
github:
  appId: 0            # the Falcon GitHub App id
  repos: [ROKT/launch-engineering]   # the allowlist; nothing else is ever reviewed
  pollSeconds: 30
chat:
  enabled: true
  spaces: [spaces/REPLACE_ME]
  pubsub: { project: REPLACE_ME, subscription: falcon-chat-pull }
  pollSeconds: 5
  maxRoundsPerPr: 3
workers: { concurrency: 6, perRepoConcurrency: 4, isolation: process }
limits:
  perReview: { maxCostUsd: 10, maxMinutes: 25 }
  daily: { perRepoUsd: 200, globalUsd: 500 }
dryRun: true          # flip to false after the first dry-run week looks right
http: { port: 8088 }
YAML

(cd "$HERE" && npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1 || npm install --omit=dev --no-audit --no-fund >/dev/null)
sed -e "s|__FALCON_HOME__|$HERE|g" -e "s|__FALCON_STATE__|$STATE|g" "$HERE/deploy/com.rokt.falcon.plist" > "$PLIST"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"
echo "installed $LABEL; logs in $STATE/logs; dashboard at http://127.0.0.1:8088/ once configured"
