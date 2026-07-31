#!/usr/bin/env bash
# wife — one-command install.
#   curl -fsSL https://raw.githubusercontent.com/ma-nucho-pro/wife/main/install.sh | bash
# or, from a clone:
#   bash install.sh
set -euo pipefail

REPO="https://github.com/ma-nucho-pro/wife.git"
green() { printf '\033[32m%s\033[0m\n' "$1"; }
red()   { printf '\033[31m%s\033[0m\n' "$1" >&2; }

command -v node >/dev/null 2>&1 || { red "Node is required. Install Node 18.17 or newer, then run this again."; exit 1; }

MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$MAJOR" -lt 18 ]; then
  red "Node $(node -v) is too old. wife needs 18.17 or newer."
  exit 1
fi

# Running from a clone, or bootstrapping from curl?
if [ -f "$(dirname "$0")/package.json" ] && grep -q '"wife-memory"' "$(dirname "$0")/package.json" 2>/dev/null; then
  DIR="$(cd "$(dirname "$0")" && pwd)"
else
  DIR="${WIFE_DIR:-$HOME/.local/share/wife}"
  echo "Cloning into $DIR"
  rm -rf "$DIR"
  mkdir -p "$(dirname "$DIR")"
  git clone --depth 1 "$REPO" "$DIR" >/dev/null
fi

cd "$DIR"
echo "Linking the wife command"
npm link >/dev/null 2>&1 || npm install -g . >/dev/null 2>&1 || {
  red "Could not install globally. Try: sudo npm link   (or add npm's global bin to your PATH)"
  exit 1
}

command -v wife >/dev/null 2>&1 || {
  red "Installed, but 'wife' is not on your PATH. Add this to your shell profile:"
  red "  export PATH=\"\$(npm prefix -g)/bin:\$PATH\""
  exit 1
}

wife init
echo
green "Done. Open a new Claude Code session and it will already know you."
echo "  wife status     see the wiring"
echo "  wife show       see what gets injected"
