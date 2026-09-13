#!/usr/bin/env bash
# CodeSwitchboard uninstaller for macOS and Linux.
#
# From inside the repository folder:
#   bash uninstall.sh
#
# Options:
#   --purge      also delete saved settings and bridge state
#   --keep-apps  skip restoring Codex and Claude Desktop to their normal accounts

set -euo pipefail

purge=0
keep_apps=0
for arg in "$@"; do
  case "$arg" in
    --purge) purge=1 ;;
    --keep-apps) keep_apps=1 ;;
    *) printf 'unknown option: %s\nusage: bash uninstall.sh [--purge] [--keep-apps]\n' "$arg" >&2; exit 1 ;;
  esac
done

script_self_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-.}")" 2>/dev/null && pwd)"
install_dir="${CODESWITCHBOARD_INSTALL_DIR:-$script_self_dir}"

# A copy of this script outside a checkout falls back to the default location.
if [ ! -f "$install_dir/package.json" ] || [ ! -f "$install_dir/uninstall.sh" ] || [ ! -d "$install_dir/.git" ]; then
  install_dir="${CODESWITCHBOARD_INSTALL_DIR:-$HOME/CodeSwitchboard}"
fi

say() { printf '\033[36m==>\033[0m %s\n' "$1"; }
fail() { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }

say 'CodeSwitchboard uninstaller'

# --- 1. Let csb uninstall do the app restores, server stop, purge, and link removal ---
csb_js="$install_dir/bin/csb.js"
if [ -f "$csb_js" ]; then
  csb_args=(uninstall --yes)
  [ "$purge" = 1 ] && csb_args+=(--purge)
  [ "$keep_apps" = 1 ] && csb_args+=(--keep-apps)
  node "$csb_js" "${csb_args[@]}" || fail "csb uninstall failed (exit $?)."
else
  say "No csb.js found at $csb_js; removing the npm link only."
  npm uninstall -g codeswitchboard
fi

# --- 2. Remove the repository folder ---
if [ "$install_dir" != "$script_self_dir" ] && [ -d "$install_dir" ]; then
  say "Removing $install_dir"
  rm -rf "$install_dir"
fi

printf '\nCodeSwitchboard uninstalled.\n'
if [ "$install_dir" = "$script_self_dir" ]; then
  printf 'The repository folder (%s) is the folder this script ran from; delete it yourself when you are done.\n' "$install_dir"
fi
