#!/usr/bin/env bash
# Installs dependencies, builds the client and starts the Krieg server, then opens the browser.
# Double-click it in the file manager, or run ./start.sh. Set PORT to use another port.

# When launched by double-click there is no terminal: reopen in one so output and errors stay visible.
if [ ! -t 1 ] && [ -z "$KRIEG_IN_TERMINAL" ]; then
  export KRIEG_IN_TERMINAL=1
  for term in ptyxis gnome-terminal konsole xfce4-terminal x-terminal-emulator xterm; do
    if command -v "$term" >/dev/null 2>&1; then
      case "$term" in
        ptyxis|gnome-terminal) exec "$term" -- "$0" "$@" ;;
        *) exec "$term" -e "$0" "$@" ;;
      esac
    fi
  done
fi

set -e
cd "$(dirname "$(readlink -f "$0")")"
PORT="${PORT:-8787}"

fail() {
  echo
  echo "ERROR: $1"
  read -rp "Press Enter to close…" _
  exit 1
}

# File managers don't load the shell profile, so look for Node in common install locations too.
if ! command -v node >/dev/null 2>&1; then
  for dir in "$HOME"/.local/share/pi-node/*/bin "$HOME"/.nvm/versions/node/*/bin "$HOME"/.volta/bin /usr/local/bin; do
    [ -x "$dir/node" ] && PATH="$dir:$PATH"
  done
fi
command -v node >/dev/null 2>&1 || fail "Node.js was not found. Install Node 22 or newer from https://nodejs.org"
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] || fail "Node 22 or newer is required (found $(node -v))."

# Install only when dependencies are missing or package-lock.json changed since the last install.
if [ ! -d node_modules ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  echo "==> Installing dependencies…"
  npm install || fail "npm install failed."
fi

echo "==> Building the client…"
npm run build || fail "The build failed."

if (echo >"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
  fail "Port $PORT is already in use (is Krieg already running?). Close it or run: PORT=8788 ./start.sh"
fi

URL="http://localhost:$PORT"
echo "==> Starting Krieg on $URL (close this window or press Ctrl+C to stop)"
# Open the browser once the server answers.
(
  for _ in $(seq 1 50); do
    if (echo >"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
      xdg-open "$URL" >/dev/null 2>&1 || open "$URL" >/dev/null 2>&1 || true
      exit 0
    fi
    sleep 0.2
  done
) &

PORT="$PORT" npm run server || fail "The server stopped unexpectedly."
