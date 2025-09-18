@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

echo Bi-directional Tests Automation Tool - Windows (CMD)
echo ================================================

REM Ensure Node is available (install via winget if missing)
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js not found in PATH. Attempting to install Node.js LTS via winget...
  where winget >nul 2>&1
  if errorlevel 1 (
    echo winget not found. Please install Node 18+ from https://nodejs.org/
    pause
    exit /b 1
  ) else (
    winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-package-agreements --accept-source-agreements
    if errorlevel 1 (
      echo Failed to install Node.js via winget. Please install Node 18+ from https://nodejs.org/
      pause
      exit /b 1
    )
    echo Re-checking Node.js installation...
    where node >nul 2>&1
    if errorlevel 1 (
      echo Node.js still not found in PATH. Please restart your terminal and try again.
      pause
      exit /b 1
    )
  )
)

REM Optional: Auto-update from Git if available (install via winget if missing)
set HAVEGIT=0
where git >nul 2>&1
if not errorlevel 1 set HAVEGIT=1
if "%HAVEGIT%"=="0" (
  echo Git not found in PATH. Attempting to install Git via winget...
  where winget >nul 2>&1
  if errorlevel 1 (
    echo winget not found. Skipping auto-update.
    echo Install Git to enable auto-update: https://git-scm.com/downloads/win
  ) else (
    winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements
    if errorlevel 1 (
      echo Failed to install Git via winget. Skipping auto-update.
    ) else (
      echo Re-checking Git installation...
      where git >nul 2>&1
      if not errorlevel 1 set HAVEGIT=1
      if "%HAVEGIT%"=="0" (
        echo Git still not found in PATH ^may require restarting terminal^. Skipping auto-update.
      )
    )
  )
)

if "%HAVEGIT%"=="1" (
  git rev-parse --is-inside-work-tree >nul 2>&1
  if errorlevel 1 (
    echo Not a Git repository. Skipping auto-update.
  ) else (
    git remote get-url origin >nul 2>&1
    if errorlevel 1 (
      echo No 'origin' remote configured. Skipping auto-update.
    ) else (
      REM Determine current branch
      for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set BRANCH=%%b
      if not defined BRANCH (
        echo Unable to determine current branch. Skipping auto-update.
      ) else (
        REM Detect local changes (dirty working tree)
        git update-index -q --refresh
        git diff-index --quiet HEAD -- >nul 2>&1
        if errorlevel 1 (
          set DIRTY=1
        ) else (
          set DIRTY=0
        )
        REM Fetch remote and check if remote is ahead
        git fetch --quiet 2>nul
        for /f "delims=" %%c in ('git rev-list --count HEAD..origin/!BRANCH! 2^>nul') do set REMOTE_AHEAD=%%c
        if not defined REMOTE_AHEAD set REMOTE_AHEAD=0
        if not "!REMOTE_AHEAD!"=="0" (
          if "!DIRTY!"=="1" (
            echo A new version is available on origin/!BRANCH!, and local changes are detected.
          ) else (
            echo A new version is available on origin/!BRANCH!.
          )
          set /p UPDATE=Update now? y/n: 
          if /I "!UPDATE!"=="Y" (
            echo Updating project ^git pull --ff-only^...
            git pull --ff-only
            if errorlevel 1 (
              echo git pull failed. You may have local/untracked changes blocking update.
              set /p FORCE=Force update and discard local changes? y/n: 
              if /I "!FORCE!"=="Y" (
                echo Forcing update: resetting to origin/!BRANCH! and cleaning untracked files...
                git fetch --all --prune
                git reset --hard origin/!BRANCH!
                git clean -fd
                if errorlevel 1 (
                  echo Force update failed. Continuing without updating.
                ) else (
                  echo Force update completed.
                )
              ) else (
                echo Skipping force update. Continuing with current local version.
              )
            )
          ) else (
            echo Skipping update. Continuing with current local version.
          )
        ) else (
          if "!DIRTY!"=="1" (
            echo Local changes detected. No remote updates. Continuing with current local version.
          ) else (
            echo Project is up to date.
          )
        )
      )
    )
  )
) else (
  REM Git unavailable; proceed without auto-update
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

:RUN_LOOP
echo Starting app...
node main.js

echo.
echo Run completed.
REM Use CHOICE for a clean Y/N prompt
CHOICE /C YN /N /M "Run again? (Y/N): "
IF ERRORLEVEL 2 GOTO END
IF ERRORLEVEL 1 GOTO RUN_LOOP

:END
echo.
echo Finished. Press any key to close.
pause >nul
endlocal

