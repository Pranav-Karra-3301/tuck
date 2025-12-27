#!/usr/bin/env bash

# tuck installer script
# Usage: curl -fsSL https://raw.githubusercontent.com/Pranav-Karra-3301/tuck/main/install.sh | bash

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

# Download and install binary
install_binary() {
    local platform="$1"
    local version="$2"
    local binary_name="${BINARY_NAME}-${platform}"
    local download_url="https://github.com/${REPO}/releases/download/${version}/${binary_name}"

    if [[ "$platform" == "win32-x64" ]]; then
        binary_name="${binary_name}.exe"
        download_url="https://github.com/${REPO}/releases/download/${version}/${binary_name}"
    fi

    info "Downloading tuck ${version} for ${platform}..."

    # Create install directory if it doesn't exist
    mkdir -p "$INSTALL_DIR"

    # Download binary
    if curl -fsSL "$download_url" -o "${INSTALL_DIR}/${BINARY_NAME}"; then
        chmod +x "${INSTALL_DIR}/${BINARY_NAME}"
        success "Installed tuck to ${INSTALL_DIR}/${BINARY_NAME}"
    else
        return 1
    fi
}

# Install via npm as fallback
install_npm() {
    info "Installing via npm..."

    if command -v npm &> /dev/null; then
        npm install -g tuck
        success "Installed tuck via npm"
    elif command -v pnpm &> /dev/null; then
        pnpm add -g tuck
        success "Installed tuck via pnpm"
    elif command -v yarn &> /dev/null; then
        yarn global add tuck
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

# Main installation logic
main() {
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
}

main "$@"
