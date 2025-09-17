@echo off
setlocal
cd /d "%~dp0"

echo Bi-directional Tests Automation Tool - Windows (CMD)
echo ================================================

REM Ensure Node is available
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js not found in PATH. Please install Node 18+ from https://nodejs.org/
  pause
  exit /b 1
)

REM Install deps at root if missing
if not exist "node_modules" (
  echo Installing dependencies...
  node src\install_dependencies.js
  if errorlevel 1 (
    echo Failed to install dependencies.
    pause
    exit /b 1
  )
)

if not exist "main.js" (
  echo main.js not found at repo root.
  pause
  exit /b 1
)

echo Starting app...
node main.js

echo.
echo Finished. Press any key to close.
pause >nul
endlocal

