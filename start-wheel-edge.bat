@echo off
cd /d "%~dp0"

echo Starting Wheel Edge...

:: Start Tiger API server in background
start "Wheel Edge API" /min cmd /c "node server.js"

:: Start React dev server in background
start "Wheel Edge App" /min cmd /c "npm start"

:: Wait for React to be ready, then open browser
timeout /t 15 /nobreak >nul
start "" "http://localhost:3000"
