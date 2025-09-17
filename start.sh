#!/bin/bash

echo "🚀 Bi-directional Tests Automation Tool - Unix/Linux/macOS"
echo "=========================================================="

# Optional: Auto-update from Git if available
if command -v git &> /dev/null; then
  if git rev-parse --is-inside-work-tree &> /dev/null; then
    if git remote get-url origin &> /dev/null; then
      # Determine current branch
      BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
      if [ -z "$BRANCH" ]; then
        echo "ℹ️  Unable to determine current branch. Skipping auto-update."
      else
        # Detect local changes (dirty working tree)
        if ! git diff-index --quiet HEAD -- 2>/dev/null; then
          DIRTY=1
        else
          DIRTY=0
        fi
        # Fetch and check if remote is ahead
        git fetch --quiet 2>/dev/null
        REMOTE_AHEAD=$(git rev-list --count HEAD..origin/$BRANCH 2>/dev/null || echo 0)
        if [ -z "$REMOTE_AHEAD" ]; then REMOTE_AHEAD=0; fi
        if [ "$REMOTE_AHEAD" != "0" ]; then
          if [ "$DIRTY" = "1" ]; then
            echo "🔔 A new version is available on origin/$BRANCH, and local changes are detected."
          else
            echo "🔔 A new version is available on origin/$BRANCH."
          fi
          read -p "Update now? (y/n): " UPDATE
          if [[ "$UPDATE" =~ ^[Yy]$ ]]; then
            echo "🔄 Updating project (git pull --ff-only)..."
            if ! git pull --ff-only; then
              echo "⚠️  git pull failed. Continuing without updating."
            fi
          else
            echo "⏭️  Skipping update. Continuing with current local version."
          fi
        else
          echo "✅ Project is up to date."
        fi
      fi
    else
      echo "ℹ️  No 'origin' remote configured. Skipping auto-update."
    fi
  else
    echo "ℹ️  Not a Git repository. Skipping auto-update."
  fi
else
  echo "ℹ️  Git not found. Skipping auto-update."
  echo "   Install Git to enable auto-update: https://git-scm.com/downloads/mac"
fi

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed or not in PATH"
    echo "Please install Node.js 18.0 or higher from https://nodejs.org/"
    exit 1
fi

# Check Node.js version
NODE_VERSION=$(node --version)
NODE_MAJOR=$(echo $NODE_VERSION | cut -d. -f1 | tr -d 'v')
if [ "$NODE_MAJOR" -lt 18 ]; then
    echo "❌ Node.js version $NODE_VERSION detected. This tool requires Node.js 18.0 or higher."
    echo "Please update Node.js and try again."
    exit 1
fi

echo "✅ Node.js $NODE_VERSION detected"

# Check if dependencies are installed at repo root (node_modules)
if [ ! -d "node_modules" ]; then
    echo "❌ Dependencies not found."
    echo ""
    read -p "Do you want to install dependencies now? (y/n): " install_choice
    if [[ $install_choice =~ ^[Yy]$ ]]; then
        echo ""
        echo "📦 Installing dependencies..."
        node src/install_dependencies.js
        if [ $? -ne 0 ]; then
            echo "❌ Failed to install dependencies."
            exit 1
        fi
        echo ""
        echo "✅ Dependencies installed successfully!"
        echo ""
    else
        echo ""
        echo "Please run 'node src/install_dependencies.js' manually and try again."
        exit 1
    fi
fi

# Check if main.js exists
if [ ! -f "main.js" ]; then
    echo "❌ main.js not found. Please run this script from the project root directory."
    exit 1
fi

echo "✅ Environment check passed"
echo ""
echo "🎯 Starting the automation tool..."
echo ""

# Run the main application
node main.js

# Check exit status
if [ $? -ne 0 ]; then
    echo ""
    echo "❌ The application exited with an error."
    echo "Please check the console output above for details."
    exit 1
else
    echo ""
    echo "✅ Application completed successfully."
fi