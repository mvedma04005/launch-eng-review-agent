#!/usr/bin/env bash
# launchd entry point. Loads secrets from an owner-only env file, never from the plist, then execs the daemon.
set -euo pipefail
HOME_DIR="${HOME:?}"
ENV_FILE="${FALCON_ENV_FILE:-$HOME_DIR/.config/falcon/env}"
if [ -f "$ENV_FILE" ]; then
  perms="$(stat -f '%Lp' "$ENV_FILE")"
  [ "$perms" = "600" ] || { echo "refusing to start: $ENV_FILE must be mode 600 (is $perms)" >&2; exit 78; }
  set -a; . "$ENV_FILE"; set +a
fi
export FALCON_CONFIG="${FALCON_CONFIG:-$HOME_DIR/.config/falcon/falcon.yaml}"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")/.."
exec node --experimental-strip-types --no-warnings src/cli.ts serve
