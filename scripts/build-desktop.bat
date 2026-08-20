@echo off
REM Handy POS Desktop App Build Script for Windows
REM Builds the Tauri app using the remote backend API (no bundled backend)

setlocal enabledelayedexpansion

echo.
echo ==========================================
echo Handy POS - Desktop App Builder (Windows)
echo ==========================================
echo.

REM Check prerequisites
echo Checking prerequisites...

where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo Error: Node.js is not installed
    exit /b 1
)

where cargo >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo Error: Rust/Cargo is not installed
    exit /b 1
)

echo [OK] All prerequisites found

REM Ensure remote API defaults for build-time config
if "%NEXT_PUBLIC_API_URL%"=="" (
    set NEXT_PUBLIC_API_URL=https://api.handypos.online/api
)
if "%NEXT_PUBLIC_API_BASE_URL%"=="" (
    set NEXT_PUBLIC_API_BASE_URL=https://api.handypos.online/api
)
if "%NEXT_PUBLIC_DJANGO_URL%"=="" (
    set NEXT_PUBLIC_DJANGO_URL=https://api.handypos.online
)

REM Step 1: Install Node dependencies
echo.
echo Step 1: Installing Node dependencies...
call npm install
if %ERRORLEVEL% NEQ 0 (
    echo Error: Failed to install Node dependencies
    exit /b 1
)
echo [OK] Node dependencies installed

REM Step 2: Build Next.js frontend
echo.
echo Step 2: Building Next.js frontend...
call npm run build
if %ERRORLEVEL% NEQ 0 (
    echo Error: Failed to build Next.js
    exit /b 1
)
echo [OK] Next.js build completed

REM Step 3: Build Tauri for Windows
echo.
echo Step 3: Building Tauri application for Windows...
call npm run tauri:build:windows:x64
if %ERRORLEVEL% NEQ 0 (
    echo Error: Failed to build Tauri
    exit /b 1
)
echo [OK] Tauri build completed

REM Show build output location
echo.
echo ==========================================
echo Build completed successfully!
echo ==========================================
echo.
echo Build artifacts are located in:
echo   src-tauri\target\x86_64-pc-windows-msvc\release\bundle\
echo.
echo Windows installers:
echo   - MSI: src-tauri\target\x86_64-pc-windows-msvc\release\bundle\msi\
echo   - EXE: src-tauri\target\x86_64-pc-windows-msvc\release\bundle\nsis\
echo.

pause
