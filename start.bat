@echo off
setlocal EnableExtensions EnableDelayedExpansion
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

REM Optional: Auto-update from Git if available
where git >nul 2>&1
if errorlevel 1 (
  echo Git not found in PATH. Skipping auto-update.
  echo Install Git to enable auto-update: https://git-scm.com/downloads/win
  echo Or via winget: winget install --id Git.Git -e --source winget
) else (
  git rev-parse --is-inside-work-tree >nul 2>&1
  if errorlevel 1 (
    echo Not a Git repository. Skipping auto-update.
  ) else (
    git remote get-url origin >nul 2>&1
    if errorlevel 1 (
      echo No 'origin' remote configured. Skipping auto-update.
    ) else (
      REM Refresh index and check for a clean working tree
      git update-index -q --refresh
      git diff-index --quiet HEAD -- >nul 2>&1
      if errorlevel 1 (
        echo Local changes detected. Skipping auto-update to avoid merge conflicts.
      ) else (
        echo Updating project ^(git pull --ff-only^)...
        git pull --ff-only
        if errorlevel 1 (
          echo git pull failed. Continuing without updating.
        )
      )
    )
  )
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

