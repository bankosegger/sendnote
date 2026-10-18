#!/bin/sh
# Installs the sendnote CLI into ~/.local/bin (override with SENDNOTE_INSTALL_DIR).
#
#   curl -fsSL __SENDNOTE_URL__/install.sh | sh
#
# Served by server.js, which fills in the URL below with its own origin.
set -eu

SENDNOTE_URL="${SENDNOTE_URL:-__SENDNOTE_URL__}"
INSTALL_DIR="${SENDNOTE_INSTALL_DIR:-$HOME/.local/bin}"

fail() {
  echo "sendnote install: $1" >&2
  exit 1
}

command -v node >/dev/null 2>&1 || fail "Node.js 20+ is required (https://nodejs.org)."
node_major=$(node -p 'process.versions.node.split(".")[0]')
[ "$node_major" -ge 20 ] || fail "Node.js 20+ is required, found $(node -v)."

mkdir -p "$INSTALL_DIR"
# A .js name matters: node --check rejects mktemp's random "extension".
tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT
tmp="$tmpdir/sendnote.js"

if command -v curl >/dev/null 2>&1; then
  curl -fsSL "$SENDNOTE_URL/cli.js" -o "$tmp" || fail "download from $SENDNOTE_URL failed."
elif command -v wget >/dev/null 2>&1; then
  wget -qO "$tmp" "$SENDNOTE_URL/cli.js" || fail "download from $SENDNOTE_URL failed."
else
  fail "curl or wget is required."
fi

# Catch an HTML error page or truncated download before installing it.
node --check "$tmp" 2>/dev/null || fail "downloaded file is not a valid script."

chmod 755 "$tmp"
mv "$tmp" "$INSTALL_DIR/sendnote"

echo "Installed sendnote to $INSTALL_DIR/sendnote (server: $SENDNOTE_URL)"
case ":$PATH:" in
  *":$INSTALL_DIR:"*) echo "Try it: echo hello | sendnote" ;;
  *) echo "Add $INSTALL_DIR to your PATH, e.g.: echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.profile" ;;
esac
