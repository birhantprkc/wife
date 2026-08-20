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

if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 18 || (major === 18 && minor >= 17) ? 0 : 1)'; then
  red "Node $(node -v) is too old. wife needs 18.17 or newer."
  exit 1
fi

# Running from a clone, or bootstrapping from curl?
if [ -f "$(dirname "$0")/package.json" ] && grep -q '"wife-memory"' "$(dirname "$0")/package.json" 2>/dev/null; then
  DIR="$(cd "$(dirname "$0")" && pwd)"
else
  DIR="${WIFE_DIR:-$HOME/.local/share/wife}"
  if [ -d "$DIR/.git" ] && [ -f "$DIR/package.json" ] && grep -q '"wife-memory"' "$DIR/package.json"; then
    echo "Updating $DIR"
    git -C "$DIR" pull --ff-only >/dev/null || {
      red "Could not update the existing checkout at $DIR. Its files were left untouched."
      exit 1
    }
  elif [ -e "$DIR" ]; then
    red "$DIR already exists and is not a Wife git checkout. Move it aside and try again."
    exit 1
  else
    echo "Cloning into $DIR"
    mkdir -p "$(dirname "$DIR")"
    git clone --depth 1 "$REPO" "$DIR" >/dev/null
  fi
fi

cd "$DIR"
echo "Linking the wife command"
npm link >/dev/null || {
  red "npm link failed. Check that npm's global prefix is writable and its bin directory is on PATH."
  red "Wife did not use sudo and did not change any permissions."
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
