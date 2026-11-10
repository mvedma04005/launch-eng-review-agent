#!/usr/bin/env bash
# One-command first install on the dedicated Mac, run as the service user:
#   curl -fsSL https://raw.githubusercontent.com/mvedma04005/launch-eng-review-agent/rebuild/v2/deploy/bootstrap-mac.sh | bash
# Clones the engine, looks for an existing Anthropic API key in the usual places (never printing it), writes the
# env file, and runs the installer. Re-running is safe.
set -euo pipefail
REPO="${FALCON_REPO:-https://github.com/mvedma04005/launch-eng-review-agent}"
BRANCH="${FALCON_BRANCH:-rebuild}"
HOME_DIR="${HOME:?}"
CHECKOUT="$HOME_DIR/falcon"
CONF_DIR="$HOME_DIR/.config/falcon"
ENV_FILE="$CONF_DIR/env"

command -v git >/dev/null || { echo "git is required (xcode-select --install or brew install git)"; exit 1; }
if [ -d "$CHECKOUT/.git" ]; then
  git -C "$CHECKOUT" fetch -q origin "$BRANCH" && git -C "$CHECKOUT" checkout -q "$BRANCH" && git -C "$CHECKOUT" pull -q --ff-only origin "$BRANCH"
else
  git clone -q --branch "$BRANCH" "$REPO" "$CHECKOUT"
fi

mkdir -p "$CONF_DIR"; chmod 700 "$CONF_DIR"
touch "$ENV_FILE"; chmod 600 "$ENV_FILE"

# Find an Anthropic API key already on this Mac. Only the first match is used; the value is never echoed.
find_key() {
  local v=""
  v="${ANTHROPIC_API_KEY:-}"
  if [ -z "$v" ]; then
    for f in "$HOME_DIR/.zshenv" "$HOME_DIR/.zprofile" "$HOME_DIR/.zshrc" "$HOME_DIR/.bash_profile" "$HOME_DIR/.bashrc" "$HOME_DIR/.profile" "$HOME_DIR/.config/anthropic/env" "$HOME_DIR/.anthropic/env"; do
      [ -f "$f" ] || continue
      v="$(grep -hE '^[[:space:]]*(export[[:space:]]+)?ANTHROPIC_API_KEY=' "$f" 2>/dev/null | tail -1 | sed -E 's/^[[:space:]]*(export[[:space:]]+)?ANTHROPIC_API_KEY=//; s/^["'"'"']//; s/["'"'"'][[:space:]]*$//' || true)"
      [ -n "$v" ] && break
    done
  fi
  if [ -z "$v" ] && command -v security >/dev/null; then
    for label in ANTHROPIC_API_KEY anthropic-api-key anthropic "Anthropic API Key"; do
      v="$(security find-generic-password -s "$label" -w 2>/dev/null || true)"
      [ -n "$v" ] && break
      v="$(security find-generic-password -l "$label" -w 2>/dev/null || true)"
      [ -n "$v" ] && break
    done
  fi
  printf '%s' "$v"
}

if ! grep -qE '^ANTHROPIC_API_KEY=.+' "$ENV_FILE"; then
  KEY="$(find_key)"
  if [ -n "$KEY" ] && printf '%s' "$KEY" | grep -qE '^sk-ant-'; then
    grep -v '^ANTHROPIC_API_KEY=' "$ENV_FILE" > "$ENV_FILE.tmp" || true
    printf 'ANTHROPIC_API_KEY=%s\n' "$KEY" >> "$ENV_FILE.tmp"
    mv "$ENV_FILE.tmp" "$ENV_FILE"; chmod 600 "$ENV_FILE"
    echo "bootstrap: found an Anthropic API key on this Mac and stored it in $ENV_FILE"
  else
    echo "bootstrap: no Anthropic API key found; add ANTHROPIC_API_KEY to $ENV_FILE"
  fi
  unset KEY
fi

bash "$CHECKOUT/v2/deploy/install-mac.sh"
echo "bootstrap: done. Edit $CONF_DIR/falcon.yaml (GitHub App id, Chat space, Pub/Sub) and $ENV_FILE, then: launchctl kickstart -k gui/$(id -u)/com.rokt.falcon"
