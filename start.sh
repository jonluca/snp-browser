#!/bin/bash

# SNP Browser - Cross-platform Start Script (Mac/Linux)
# This script installs bun if needed, installs dependencies, and runs production build

set -e  # Exit on error

echo "========================================="
echo "SNP Browser - Production Start Script"
echo "========================================="
echo ""

# Check if bun is installed
if ! command -v bun &> /dev/null; then
    echo "Bun is not installed. Installing bun..."
    echo ""
    curl -fsSL https://bun.sh/install | bash

    # Source the bun environment
    export BUN_INSTALL="$HOME/.bun"
    export PATH="$BUN_INSTALL/bin:$PATH"

    echo ""
    echo "Bun installed successfully!"
    echo ""
else
    echo "Bun is already installed ($(bun --version))"
    echo ""
fi

# Install dependencies
echo "Installing dependencies..."
echo ""
bun install

echo ""
echo "========================================="
echo "Building and starting production server..."
echo "========================================="
echo ""

# Run production build and preview
bun run prod
