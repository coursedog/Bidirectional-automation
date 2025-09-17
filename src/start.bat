@echo off
chcp 65001 >nul
echo 🚀 Bi-directional Tests Automation Tool - Windows
echo ================================================

REM Check if Node.js is installed
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo ❌ Node.js is not installed or not in PATH
    echo Please install Node.js 18.0 or higher from https://nodejs.org/
    pause
    exit /b 1
)

REM Check if dependencies are installed
if not exist "node_modules" (
    echo ❌ Dependencies not found, proceeding to install them...
    echo.
    echo 📦 Installing dependencies...
    node install_dependencies.js
    if %errorlevel% neq 0 (
        echo ❌ Failed to install dependencies.
        exit /b 1
    )
    echo.
    echo ✅ Dependencies installed successfully!
    echo.
)

REM Check if index.js exists
if not exist "index.js" (
    echo ❌ index.js not found. Please run this script from the project root directory.
    pause
    exit /b 1
)

echo ✅ Environment check passed
echo.
echo 🎯 Starting the automation tool...
echo.

:run_app
REM Run the main application
node index.js

if %errorlevel% neq 0 (
    echo.
    echo ❌ The application exited with an error.
    echo Restarting... Press Ctrl+C to exit.
) else (
    echo.
    echo ✅ Application completed successfully.
    echo Restarting... Press Ctrl+C to exit.
)
echo.
goto run_app