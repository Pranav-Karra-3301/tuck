#!/usr/bin/env bash

# tuck installer script
#
# Install only:
#   curl -fsSL https://raw.githubusercontent.com/Pranav-Karra-3301/tuck/main/install.sh | bash
#
# Install AND bootstrap a machine from a dotfiles repo in one shot (idempotent —
# safe to re-run; it converges instead of erroring):
#   curl -fsSL https://raw.githubusercontent.com/Pranav-Karra-3301/tuck/main/install.sh | bash -s -- <user-or-repo> [tuck bootstrap flags...]
#
# Examples:
#   ... | bash -s -- octocat                 # find octocat's dotfiles and set up this machine
#   ... | bash -s -- octocat/dotfiles --yes  # non-interactive
#   ... | bash -s -- octocat --skip-packages # dotfiles only, no package installs

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Configuration
REPO="Pranav-Karra-3301/tuck"
BINARY_NAME="tuck"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"

# Helper functions
info() {
    echo -e "${CYAN}[INFO]${NC} $1"
}

success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1"
    exit 1
}

# Detect platform
detect_platform() {
    local os arch

    case "$(uname -s)" in
        Linux*)  os="linux" ;;
        Darwin*) os="darwin" ;;
        MINGW*|MSYS*|CYGWIN*) os="win32" ;;
        *) error "Unsupported operating system: $(uname -s)" ;;
    esac

    case "$(uname -m)" in
        x86_64|amd64) arch="x64" ;;
        aarch64|arm64) arch="arm64" ;;
        *) error "Unsupported architecture: $(uname -m)" ;;
    esac

    echo "${os}-${arch}"
}

# Get latest release version
get_latest_version() {
    curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" | grep '"tag_name":' | sed -E 's/.*"([^"]+)".*/\1/'
}

sha256_file() {
    local file="$1"
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$file" | awk '{print $1}'
    elif command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "$file" | awk '{print $1}'
    elif command -v openssl >/dev/null 2>&1; then
        openssl dgst -sha256 "$file" | awk '{print $NF}'
    else
        error "No SHA256 tool found (need sha256sum, shasum, or openssl)"
    fi
}

verify_checksum() {
    local checksum_file="$1"
    local asset_name="$2"
    local downloaded_file="$3"

    local expected
    expected=$(awk -v asset="$asset_name" '$2 == asset || $2 == ("*" asset) { print $1; exit }' "$checksum_file")

    if [[ -z "$expected" ]]; then
        error "Could not find checksum for ${asset_name} in SHA256SUMS"
    fi

    local actual
    actual=$(sha256_file "$downloaded_file")

    if [[ "$expected" != "$actual" ]]; then
        error "Checksum verification failed for ${asset_name}"
    fi
}

# Download and install binary
install_binary() {
    local platform="$1"
    local version="$2"
    local asset_name="${BINARY_NAME}-${platform}"
    local output_name="${BINARY_NAME}"
    local base_url="https://github.com/${REPO}/releases/download/${version}"

    if [[ "$platform" == win32-* ]]; then
        asset_name="${asset_name}.exe"
        output_name="${BINARY_NAME}.exe"
    fi

    info "Downloading tuck ${version} for ${platform}..."

    # Create install directory if it doesn't exist
    mkdir -p "$INSTALL_DIR"

    local tmp_binary tmp_checksums
    tmp_binary="$(mktemp)"
    tmp_checksums="$(mktemp)"

    # Download binary and checksum manifest
    if ! curl -fsSL "${base_url}/${asset_name}" -o "$tmp_binary"; then
        rm -f "$tmp_binary" "$tmp_checksums"
        return 1
    fi
    if ! curl -fsSL "${base_url}/SHA256SUMS" -o "$tmp_checksums"; then
        rm -f "$tmp_binary" "$tmp_checksums"
        return 1
    fi

    verify_checksum "$tmp_checksums" "$asset_name" "$tmp_binary"

    mv "$tmp_binary" "${INSTALL_DIR}/${output_name}"
    chmod +x "${INSTALL_DIR}/${output_name}"
    rm -f "$tmp_checksums"
    success "Installed tuck to ${INSTALL_DIR}/${output_name}"
}

# Install via npm as fallback
install_npm() {
    info "Installing via npm..."

    if command -v npm &> /dev/null; then
        npm install -g @prnv/tuck
        success "Installed tuck via npm"
    elif command -v pnpm &> /dev/null; then
        pnpm add -g @prnv/tuck
        success "Installed tuck via pnpm"
    elif command -v yarn &> /dev/null; then
        yarn global add @prnv/tuck
        success "Installed tuck via yarn"
    else
        error "No package manager found. Please install Node.js and npm first."
    fi
}

# Check if install directory is in PATH
check_path() {
    if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
        warn "Installation directory is not in your PATH."
        echo ""
        echo "Add the following to your shell profile (~/.bashrc, ~/.zshrc, etc.):"
        echo ""
        echo "  export PATH=\"\$PATH:$INSTALL_DIR\""
        echo ""
    fi
}

# Resolve the tuck executable after install (freshly-installed dir may not be on
# the current shell's PATH yet), preferring the location we just wrote to.
resolve_tuck_bin() {
    if [[ -x "${INSTALL_DIR}/tuck" ]]; then
        echo "${INSTALL_DIR}/tuck"
    elif command -v tuck >/dev/null 2>&1; then
        command -v tuck
    else
        echo ""
    fi
}

# Run `tuck bootstrap <repo>` after a successful install. Accepts the repo as the
# first argument and forwards any remaining arguments to `tuck bootstrap`.
run_bootstrap() {
    local repo="$1"
    shift

    local tuck_bin
    tuck_bin="$(resolve_tuck_bin)"
    if [[ -z "$tuck_bin" ]]; then
        error "Could not locate the tuck executable after install; open a new shell and run: tuck bootstrap ${repo}"
    fi

    echo ""
    info "Bootstrapping this machine from ${repo}..."
    echo ""
    # Re-runnable by design: `tuck bootstrap` converges on repeat runs.
    "$tuck_bin" bootstrap "$repo" "$@"
}

# Main installation logic
main() {
    # First positional argument (if any) is the dotfiles repo to bootstrap from;
    # everything after it is forwarded verbatim to `tuck bootstrap`.
    local bootstrap_repo=""
    local -a bootstrap_args=()
    if [[ $# -gt 0 ]]; then
        bootstrap_repo="$1"
        shift
        bootstrap_args=("$@")
    fi

    echo ""
    echo -e "${CYAN}╔════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║       ${GREEN}tuck${CYAN} - Dotfiles Manager          ║${NC}"
    echo -e "${CYAN}╚════════════════════════════════════════╝${NC}"
    echo ""

    local platform
    platform=$(detect_platform)
    info "Detected platform: ${platform}"

    # Try to get latest version and install binary
    local version
    if version=$(get_latest_version 2>/dev/null) && [[ -n "$version" ]]; then
        info "Latest version: ${version}"

        if install_binary "$platform" "$version"; then
            check_path
            echo ""
            success "Installation complete! Run 'tuck --help' to get started."
            if [[ -n "$bootstrap_repo" ]]; then
                run_bootstrap "$bootstrap_repo" ${bootstrap_args[@]+"${bootstrap_args[@]}"}
            fi
            return 0
        else
            warn "Binary download failed, falling back to npm..."
        fi
    else
        warn "Could not fetch latest release, falling back to npm..."
    fi

    # Fallback to npm installation
    install_npm

    echo ""
    success "Installation complete! Run 'tuck --help' to get started."

    if [[ -n "$bootstrap_repo" ]]; then
        run_bootstrap "$bootstrap_repo" ${bootstrap_args[@]+"${bootstrap_args[@]}"}
    fi
}

main "$@"
