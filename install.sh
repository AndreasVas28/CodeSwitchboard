#!/usr/bin/env bash
# CodeSwitchboard installer for macOS and Linux.
#
# Run from any terminal:
#   curl -fsSL https://raw.githubusercontent.com/AndreasVas28/CodeSwitchboard/HEAD/install.sh | bash
#
# Or inspect first, then run:
#   curl -fsSL ... -o install.sh && less install.sh && bash install.sh

set -euo pipefail

repo_url='https://github.com/AndreasVas28/CodeSwitchboard.git'
install_dir="$HOME/CodeSwitchboard"

say() { printf '\033[36m==>\033[0m %s\n' "$1"; }
fail() { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

node_major() { node --version 2>/dev/null | sed 's/^v//' | cut -d. -f1; }

install_node() {
  say 'Node.js 20+ not found. Installing...'
  if have brew; then
    brew install node
  elif have apt-get; then
    sudo apt-get update && sudo apt-get install -y curl ca-certificates
    curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
    sudo apt-get install -y nodejs
  elif have dnf; then
    curl -fsSL https://rpm.nodesource.com/setup_lts.x | sudo bash -
    sudo dnf install -y nodejs
  elif have pacman; then
    sudo pacman -Sy --noconfirm nodejs npm
  elif have zypper; then
    sudo zypper install -y nodejs20
  else
    fail 'Node.js 20 or newer is required. Install it from https://nodejs.org and run the installer again.'
  fi
}

# --- 1. Prerequisites -------------------------------------------------------
have git || fail 'git is required. Install it with your package manager and run the installer again.'

if ! have node || [ "$(node_major)" -lt 20 ]; then
  install_node
  have node || fail 'Node.js was installed but is not on PATH yet. Open a new terminal and run the installer again.'
  [ "$(node_major)" -ge 20 ] || fail 'Node.js 20 or newer is required.'
fi

# --- 2. Clone or update the repository --------------------------------------
if [ -d "$install_dir/.git" ]; then
  say "Updating existing checkout at $install_dir"
  git -C "$install_dir" pull --ff-only
else
  say "Cloning into $install_dir"
  git clone "$repo_url" "$install_dir"
fi

# --- 3. Dependencies + the global csb command -------------------------------
cd "$install_dir"
say 'Installing dependencies (npm ci)...'
if ! npm ci; then
  fail 'npm ci failed. Check the output above, fix the issue, and run the installer again.'
fi

say 'Linking the csb command (npm link)...'
if ! npm link; then
  cat >&2 <<'EOF'
npm link failed (a global prefix permission issue is the usual cause). Alternatives:

  sudo npm link                     # if your global prefix needs root
  npm config set prefix ~/.npm-global
  npm link                          # then add ~/.npm-global/bin to PATH

You can also skip the global command and start CodeSwitchboard with:
  node ~/CodeSwitchboard/bin/csb.js open
EOF
  exit 1
fi

# npm link needs the bin script to be executable on some systems.
chmod +x bin/csb.js 2>/dev/null || true

cat <<'EOF'

CodeSwitchboard installed.
  Start it:        csb open
  Check status:    csb info
  Install targets: csb install --recommended --yes

If csb is not found, open a new terminal first.
EOF
