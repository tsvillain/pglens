#!/bin/bash

# pglens installation script
# Usage: curl -fsSL https://pglens.org/install.sh | bash
#
# Installs a self-contained pglens under ~/.pglens (bundled Node if needed),
# a launcher at ~/.pglens/bin/pglens, and prepends that dir to PATH so the
# curl-managed copy always wins. Re-run any time to upgrade.

set -e

INSTALL_DIR="$HOME/.pglens"
BIN_DIR="$INSTALL_DIR/bin"
NODE_DIR="$INSTALL_DIR/node"
NODE_VERSION="v20.11.0"
LAUNCHER_PATH="$BIN_DIR/pglens"

# Detect OS and Arch
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
    Linux*)     OS_TYPE="linux";;
    Darwin*)    OS_TYPE="darwin";;
    *)          echo "Unsupported OS: $OS"; exit 1;;
esac

case "$ARCH" in
    x86_64)    ARCH_TYPE="x64";;
    aarch64|arm64) ARCH_TYPE="arm64";;
    *)         echo "Unsupported architecture: $ARCH"; exit 1;;
esac

echo "Installing pglens..."

# Warn about any pre-existing pglens that isn't this launcher — e.g. a global
# `npm i -g pglens`. Two copies on PATH is the #1 cause of "upgrade didn't
# take", so flag it up front. Non-fatal.
EXISTING="$(command -v pglens 2>/dev/null || true)"
if [ -n "$EXISTING" ] && [ "$EXISTING" != "$LAUNCHER_PATH" ]; then
    echo ""
    echo "  ⚠  Another pglens is already on your PATH:"
    echo "       $EXISTING"
    echo "     After this install, run 'pglens doctor' to find and remove"
    echo "     the duplicate so the two copies don't shadow each other."
    echo ""
fi

# Create directories
mkdir -p "$INSTALL_DIR"
mkdir -p "$BIN_DIR"

# 1. Check for Node.js
REQUIRED_NODE_VERSION=18
NODE_CMD="node"
NPM_CMD="npm"
INSTALL_NODE=false

if command -v node >/dev/null 2>&1; then
    CURRENT_NODE_VERSION=$(node -v | cut -d'.' -f1 | tr -d 'v')
    if [ "$CURRENT_NODE_VERSION" -ge "$REQUIRED_NODE_VERSION" ]; then
        echo "✓ Node.js $CURRENT_NODE_VERSION detected."
    else
        echo "Node.js detected but version $CURRENT_NODE_VERSION is older than required ($REQUIRED_NODE_VERSION)."
        INSTALL_NODE=true
    fi
else
    echo "Node.js not found."
    INSTALL_NODE=true
fi

if [ "$INSTALL_NODE" = true ]; then
    echo "Installing standalone Node.js $NODE_VERSION to $NODE_DIR..."

    rm -rf "$NODE_DIR"
    mkdir -p "$NODE_DIR"

    NODE_DIST="node-$NODE_VERSION-$OS_TYPE-$ARCH_TYPE"
    NODE_URL="https://nodejs.org/dist/$NODE_VERSION/$NODE_DIST.tar.gz"

    echo "Downloading Node.js from $NODE_URL..."
    curl -fsSL "$NODE_URL" | tar -xz -C "$NODE_DIR" --strip-components=1

    NODE_CMD="$NODE_DIR/bin/node"
    NPM_CMD="$NODE_DIR/bin/npm"

    echo "✓ Node.js installed locally."
fi

# 2. Install (or upgrade) pglens via npm, strictly under ~/.pglens to avoid
# global side effects. @latest makes a re-run a clean upgrade.
echo "Installing pglens via npm..."
# Suppress the package's postinstall doctor notice: the launcher and PATH
# line aren't written until later in this script, so it would otherwise warn
# that the install "isn't on PATH" mid-run. We print our own status below.
PGLENS_NO_POSTINSTALL=1 "$NPM_CMD" install --prefix "$INSTALL_DIR" pglens@latest

# 3. Create launcher script
BINARY_PATH="$INSTALL_DIR/node_modules/.bin/pglens"
if [ ! -f "$BINARY_PATH" ]; then
    # npm --prefix can place bins in prefix/bin depending on version
    if [ -f "$INSTALL_DIR/bin/pglens" ] && [ ! -L "$INSTALL_DIR/bin/pglens" ]; then
        BINARY_PATH="$INSTALL_DIR/bin/pglens"
    fi
fi

echo "Creating launcher at $LAUNCHER_PATH..."
cat > "$LAUNCHER_PATH" <<EOF
#!/bin/bash
exec "$NODE_CMD" "$BINARY_PATH" "\$@"
EOF
chmod +x "$LAUNCHER_PATH"

# 4. Add to PATH (prepend, so the curl-managed pglens takes precedence over any
# other copy). Idempotent: only written once per rc file.
SHELL_CONFIG=""
case "$SHELL" in
    */zsh) SHELL_CONFIG="$HOME/.zshrc" ;;
    */bash) SHELL_CONFIG="$HOME/.bashrc" ;;
    *) echo "Warning: Could not detect shell. Manually prepend $BIN_DIR to your PATH.";;
esac

PATH_UPDATED=false
if [ -n "$SHELL_CONFIG" ]; then
    if ! grep -q "$BIN_DIR" "$SHELL_CONFIG" 2>/dev/null; then
        {
            echo ""
            echo "# pglens"
            echo "export PATH=\"$BIN_DIR:\$PATH\""
        } >> "$SHELL_CONFIG"
        echo "Added $BIN_DIR to $SHELL_CONFIG"
        PATH_UPDATED=true
    else
        echo "$BIN_DIR is already in $SHELL_CONFIG"
    fi
fi

echo ""
echo "✓ Successfully installed pglens $("$NODE_CMD" "$BINARY_PATH" --version 2>/dev/null)!"
echo ""
if [ "$PATH_UPDATED" = true ]; then
    echo "Open a new terminal (or 'source $SHELL_CONFIG') so pglens is on your PATH,"
else
    # PATH already set; if upgrading, the shell may have cached the old path.
    echo "Run 'hash -r' or open a new terminal to refresh the cached path,"
fi
echo "then run 'pglens start' to launch the server."
