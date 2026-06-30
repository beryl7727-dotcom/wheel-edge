@echo off
setlocal enabledelayedexpansion

echo.
echo  ╔══════════════════════════════════════════╗
echo  ║   Wheel Edge — Desktop Build Script      ║
echo  ║   Produces a Windows installer (.exe)    ║
echo  ╚══════════════════════════════════════════╝
echo.

:: ── Pre-flight checks ──────────────────────────────────────────────────────

echo [1/5] Checking prerequisites...

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo  ERROR: Node.js not found. Install from https://nodejs.org/
    pause & exit /b 1
)

if not exist "node_modules" (
    echo  ERROR: node_modules missing. Run:  npm install
    pause & exit /b 1
)

if not exist "tiger_openapi_config.properties" (
    echo  WARNING: tiger_openapi_config.properties not found.
    echo           Tiger API will be unavailable in the desktop app.
    echo           Copy your properties file to this folder and re-run.
    echo.
)

if not exist ".env" (
    echo  WARNING: .env not found.
    echo           Supabase sync will be unavailable. The app will still work offline.
    echo.
)

:: ── Build React app ─────────────────────────────────────────────────────────

echo [2/5] Building React application...
call npm run build
if %errorlevel% neq 0 (
    echo  ERROR: React build failed. Check the output above.
    pause & exit /b 1
)
echo  React build complete.

:: ── Verify required files ───────────────────────────────────────────────────

echo [3/5] Verifying build artifacts...

if not exist "build\index.html" (
    echo  ERROR: build\index.html not found after React build.
    pause & exit /b 1
)

if not exist "public\main.js" (
    echo  ERROR: public\main.js not found.
    pause & exit /b 1
)

if not exist "public\icon.ico" (
    echo  ERROR: public\icon.ico not found. Run:  npm run generate-icons
    pause & exit /b 1
)

echo  All artifacts present.

:: ── Package with Electron Builder ──────────────────────────────────────────

echo [4/5] Packaging with Electron Builder (Windows)...
echo  This takes 3-8 minutes. Please wait...
echo.
call npx electron-builder --win --x64
if %errorlevel% neq 0 (
    echo  ERROR: Electron Builder failed. Check the output above.
    pause & exit /b 1
)

:: ── Done ────────────────────────────────────────────────────────────────────

echo.
echo [5/5] Build complete!
echo.
echo  Output files:
echo.
dir /b "dist\*.exe" 2>nul
echo.
echo  ┌─────────────────────────────────────────────────────────┐
echo  │  Installer:  dist\Wheel Edge Setup x.x.x.exe           │
echo  │  Portable:   dist\Wheel Edge x.x.x.exe  (no install)   │
echo  └─────────────────────────────────────────────────────────┘
echo.
echo  To install: double-click the Setup .exe
echo  To run portable: double-click Wheel Edge x.x.x.exe
echo.

set /p openDist="Open dist folder now? (y/n): "
if /i "%openDist%"=="y" explorer dist

pause
