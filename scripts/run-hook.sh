#!/bin/sh
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
HANDLER="$SCRIPT_DIR/hook-handler.mjs"

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
  "$HOME/Applications/Antigravity.app/Contents/MacOS/Antigravity"
do
  if [ -x "$APP_BIN" ]; then
    ELECTRON_RUN_AS_NODE=1 exec "$APP_BIN" "$HANDLER" "$@"
  fi
done

exec node "$HANDLER" "$@"
