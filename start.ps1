# SNP Browser - PowerShell Start Script (Windows)
# This script installs bun if needed, installs dependencies, and runs production build

$ErrorActionPreference = "Stop"

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "SNP Browser - Production Start Script" -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host ""

# Check if bun is installed
$bunInstalled = Get-Command bun -ErrorAction SilentlyContinue

if (-not $bunInstalled) {
    Write-Host "Bun is not installed. Installing bun..." -ForegroundColor Yellow
    Write-Host ""

    # Install bun using the official installer
    try {
        irm bun.sh/install.ps1 | iex

        # Refresh PATH to include bun
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")

        Write-Host ""
        Write-Host "Bun installed successfully!" -ForegroundColor Green
        Write-Host ""
    }
    catch {
        Write-Host "Error installing bun: $_" -ForegroundColor Red
        Write-Host "Please install bun manually from https://bun.sh" -ForegroundColor Red
        exit 1
    }
}
else {
    Write-Host "Bun is already installed ($(bun --version))" -ForegroundColor Green
    Write-Host ""
}

# Install dependencies
Write-Host "Installing dependencies..." -ForegroundColor Cyan
Write-Host ""
bun install

Write-Host ""
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "Building and starting production server..." -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan
Write-Host ""

# Run production build and preview
bun run prod
