@echo off
REM SNP Browser - Windows Start Script
REM This script installs bun if needed, installs dependencies, and runs production build

echo =========================================
echo SNP Browser - Production Start Script
echo =========================================
echo.

REM Check if bun is installed
where bun >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo Bun is not installed. Installing bun...
    echo.
    echo Please run this command in PowerShell to install bun:
    echo irm bun.sh/install.ps1 ^| iex
    echo.
    echo After installation, please run this script again.
    pause
    exit /b 1
) else (
    echo Bun is already installed
    bun --version
    echo.
)

REM Install dependencies
echo Installing dependencies...
echo.
bun install

echo.
echo =========================================
echo Building and starting production server...
echo =========================================
echo.

REM Run production build and preview
bun run prod
