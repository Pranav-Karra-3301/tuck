#!/usr/bin/env bash
# Single-shot installer for tuck.
#
#   curl -fsSL https://tuck.sh/install | sh
#
# Picks the correct prebuilt binary for the host, downloads it from the
# latest GitHub Release, verifies it's executable, and drops it in either
# /usr/local/bin (preferred) or $HOME/.local/bin.
#
# Designed to be safe to re-run; will overwrite an existing tuck binary
# without prompting and print where it was installed.

set -euo pipefail

REPO="Pranav-Karra-3301/tuck"

OS=""
case "$(uname -s)" in
  Darwin) OS="darwin" ;;
  Linux)  OS="linux"  ;;
  *)
    echo "error: unsupported OS: $(uname -s)" >&2
    echo "Install via npm instead: npm i -g @prnv/tuck" >&2
    exit 1
    ;;
esac

ARCH=""
case "$(uname -m)" in
  x86_64|amd64) ARCH="x64" ;;
  arm64|aarch64) ARCH="arm64" ;;
  *)
    echo "error: unsupported arch: $(uname -m)" >&2
    exit 1
    ;;
esac

BIN_NAME="tuck-${OS}-${ARCH}"
RELEASE_URL="https://github.com/${REPO}/releases/latest/download/${BIN_NAME}"

INSTALL_DIR="/usr/local/bin"
if [ ! -w "$INSTALL_DIR" ]; then
  INSTALL_DIR="$HOME/.local/bin"
  mkdir -p "$INSTALL_DIR"
fi

TMP="$(mktemp -t tuck-install.XXXXXX)"
trap 'rm -f "$TMP"' EXIT

echo "→ Downloading $BIN_NAME"
curl -fL --progress-bar -o "$TMP" "$RELEASE_URL"

chmod +x "$TMP"
mv -f "$TMP" "$INSTALL_DIR/tuck"

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    echo "warning: $INSTALL_DIR is not on your PATH."
    echo "Add this to your shell rc:"
    echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
    ;;
esac

echo "✓ Installed tuck to $INSTALL_DIR/tuck"
"$INSTALL_DIR/tuck" --version
