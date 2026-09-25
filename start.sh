#!/usr/bin/env bash
# Linux and macOS: installs dependencies, builds the client and starts the Cabinet Wars server, then
# opens the browser. Double-click it in the file manager, or run ./start.sh. Set PORT to use another
# port. (On Windows, use start.bat.)

# When launched by double-click there is no terminal: reopen in one so output and errors stay visible.
if [ ! -t 1 ] && [ -z "$CABINET_WARS_IN_TERMINAL" ]; then
  export CABINET_WARS_IN_TERMINAL=1
  for term in ptyxis gnome-terminal konsole xfce4-terminal x-terminal-emulator xterm; do
    if command -v "$term" >/dev/null 2>&1; then
      case "$term" in
        ptyxis|gnome-terminal) exec "$term" -- "$0" "$@" ;;
        *) exec "$term" -e "$0" "$@" ;;
      esac
    fi
  done
fi

cd "$(dirname "$(readlink -f "$0")")"

fail() {
  echo
  echo "ERROR: $1"
  read -rp "Press Enter to close…" _
  exit 1
}

# File managers don't load the shell profile, so look for Node in common install locations too.
if ! command -v node >/dev/null 2>&1; then
  for dir in "$HOME"/.local/share/pi-node/*/bin "$HOME"/.nvm/versions/node/*/bin "$HOME"/.volta/bin /usr/local/bin /opt/homebrew/bin; do
    [ -x "$dir/node" ] && PATH="$dir:$PATH"
  done
fi
command -v node >/dev/null 2>&1 || fail "Node.js was not found. Install Node 22 or newer from https://nodejs.org"

# The rest is the same on every system: scripts/start.mjs.
node scripts/start.mjs "$@" || fail "Cabinet Wars stopped with an error (see above)."
