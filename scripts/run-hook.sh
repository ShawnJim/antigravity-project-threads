#!/bin/sh
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
HANDLER="$SCRIPT_DIR/hook-handler.mjs"

if command -v node >/dev/null 2>&1; then
  exec node "$HANDLER" "$@"
fi

if [ -n "${NVM_BIN:-}" ] && [ -x "$NVM_BIN/node" ]; then
  exec "$NVM_BIN/node" "$HANDLER" "$@"
fi

if [ -n "${NVM_DIR:-}" ]; then
  for NODE_BIN in "$NVM_DIR/versions/node/"*/bin/node; do
    if [ -x "$NODE_BIN" ]; then
      exec "$NODE_BIN" "$HANDLER" "$@"
    fi
  done
fi

for NODE_BIN in \
  "/opt/homebrew/bin/node" \
  "/usr/local/bin/node" \
  "/opt/local/bin/node" \
  "/home/linuxbrew/.linuxbrew/bin/node" \
  "$HOME/.volta/bin/node" \
  "$HOME/.asdf/shims/node" \
  "${XDG_DATA_HOME:-$HOME/.local/share}/mise/shims/node" \
  "$HOME/.local/bin/node" \
  "$HOME/.fnm/aliases/default/bin/node" \
  "${XDG_DATA_HOME:-$HOME/.local/share}/fnm/aliases/default/bin/node" \
  "$HOME/.fnm/node-versions/"*/installation/bin/node \
  "${XDG_DATA_HOME:-$HOME/.local/share}/fnm/node-versions/"*/installation/bin/node \
  "${XDG_STATE_HOME:-$HOME/.local/state}/fnm_multishells/"*/bin/node \
  "$HOME/.nvm/versions/node/"*/bin/node \
  "${XDG_CONFIG_HOME:-$HOME/.config}/nvm/versions/node/"*/bin/node \
  "/usr/local/n/versions/node/"*/bin/node \
  "$HOME/n/bin/node" \
  "/snap/bin/node" \
  "/usr/bin/node"
do
  if [ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ]; then
    exec "$NODE_BIN" "$HANDLER" "$@"
  fi
done

for CANDIDATE in \
  "${ANTIGRAVITY_USER_DATA_DIR:+$ANTIGRAVITY_USER_DATA_DIR/bin/agy-node}" \
  "$HOME/Library/Application Support/Antigravity/bin/agy-node" \
  "${XDG_CONFIG_HOME:-$HOME/.config}/Antigravity/bin/agy-node" \
  "$HOME/.gemini/antigravity/bin/agy-node"
do
  if [ -n "$CANDIDATE" ] && [ -x "$CANDIDATE" ]; then
    exec "$CANDIDATE" "$HANDLER" "$@"
  fi
done

if command -v agy-node >/dev/null 2>&1; then
  exec agy-node "$HANDLER" "$@"
fi

for APP_BIN in \
  "/Applications/Antigravity.app/Contents/MacOS/Antigravity" \
  "$HOME/Applications/Antigravity.app/Contents/MacOS/Antigravity" \
  "/usr/share/antigravity/antigravity" \
  "/usr/lib/antigravity/antigravity" \
  "/opt/antigravity/antigravity" \
  "/opt/Antigravity/antigravity" \
  "/opt/Antigravity/Antigravity" \
  "$HOME/.local/share/antigravity/antigravity" \
  "$HOME/.local/share/Antigravity/antigravity" \
  "$HOME/Applications/antigravity/antigravity" \
  "/snap/antigravity/current/usr/share/antigravity/antigravity"
do
  if [ -x "$APP_BIN" ]; then
    ELECTRON_RUN_AS_NODE=1 exec "$APP_BIN" "$HANDLER" "$@"
  fi
done

case "${1:-}" in
  Stop)
    printf '{"decision":"stop"}\n'
    ;;
  PreToolUse)
    printf '{"decision":"allow"}\n'
    ;;
  *)
    printf '{}\n'
    ;;
esac
