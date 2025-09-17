#!/bin/bash

set -euo pipefail

echo "🚀 Bi-directional Tests Automation Tool - Unix/Linux/macOS"
echo "=========================================================="

# Helper to refresh PATH for current shell after installs
rehash_path() {
  hash -r 2>/dev/null || true
  if [ -f /opt/homebrew/bin/brew ]; then
    eval "$((/opt/homebrew/bin/brew --prefix)/bin/brew) shellenv" >/dev/null 2>&1 || true
  elif [ -f /usr/local/bin/brew ]; then
    eval "$((/usr/local/bin/brew --prefix)/bin/brew) shellenv" >/dev/null 2>&1 || true
  fi
}

# Ensure Homebrew is available (try to auto-install if missing)
if ! command -v brew &> /dev/null; then
  echo "ℹ️  Homebrew not found. Attempting to install Homebrew..."
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" || true
  rehash_path
  if ! command -v brew &> /dev/null; then
    echo "⚠️  Failed to install Homebrew automatically. Proceeding without Homebrew."
  else
    echo "✅ Homebrew installed successfully."
  fi
fi

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
        git fetch --quiet 2>/dev/null || true
        REMOTE_AHEAD=$(git rev-list --count HEAD..origin/$BRANCH 2>/dev/null || echo 0)
        if [ -z "$REMOTE_AHEAD" ]; then REMOTE_AHEAD=0; fi
        if [ "$REMOTE_AHEAD" != "0" ]; then
          echo "🔔 A new version is available on origin/$BRANCH."
          read -p "Update now? (y/n): " UPDATE
          if [[ "$UPDATE" =~ ^[Yy]$ ]]; then
            echo "🔄 Updating project (git pull --ff-only)..."
            if ! git pull --ff-only; then
              echo "⚠️  git pull failed. You may have local or untracked changes blocking update."
              read -p "Force update and discard local changes? (y/n): " FORCE
              if [[ "$FORCE" =~ ^[Yy]$ ]]; then
                echo "⚠️  Forcing update: resetting to origin/$BRANCH and cleaning untracked files..."
                git fetch --all --prune || true
                if git reset --hard origin/$BRANCH && git clean -fd; then
                  echo "✅ Force update completed."
                else
                  echo "⚠️  Force update failed. Continuing without updating."
                fi
              else
                echo "⏭️  Skipping force update. Continuing with current local version."
              fi
            fi
          else
            echo "⏭️  Skipping update. Continuing with current local version."
          fi
        else
          if [ "$DIRTY" = "1" ]; then
            echo "ℹ️  Local changes detected. No remote updates. Continuing with current local version."
          else
            echo "✅ Project is up to date."
          fi
        fi
      fi
    else
      echo "ℹ️  No 'origin' remote configured. Skipping auto-update."
    fi
  else
    echo "ℹ️  Not a Git repository. Skipping auto-update."
  fi
else
  echo "ℹ️  Git not found."
  if command -v brew &> /dev/null; then
    echo "Attempting to install Git via Homebrew..."
    brew update >/dev/null 2>&1 || true
    if brew list git >/dev/null 2>&1 || brew install git; then
      echo "✅ Git installed via Homebrew."
      rehash_path
    else
      echo "⚠️  Failed to install Git via Homebrew."
      if ! xcode-select -p >/dev/null 2>&1; then
        echo "📦 You can install Apple's Command Line Tools (includes git) with: xcode-select --install"
      fi
    fi
  else
    if ! xcode-select -p >/dev/null 2>&1; then
      echo "📦 You can install Apple's Command Line Tools (includes git) with: xcode-select --install"
    fi
    echo "Or install Homebrew first: https://brew.sh and then: brew install git"
  fi
fi

# Ensure Node.js is installed (attempt Homebrew install if missing; else nvm fallback)
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed or not in PATH."
    if command -v brew &> /dev/null; then
        echo "Attempting to install Node.js via Homebrew..."
        brew update >/dev/null 2>&1 || true
        if brew list node >/dev/null 2>&1 || brew install node; then
            echo "✅ Node.js installed via Homebrew."
            rehash_path
        else
            echo "⚠️  Failed to install Node.js via Homebrew. Falling back to nvm (user install)."
        fi
    fi
    if ! command -v node &> /dev/null; then
        # nvm fallback (no sudo required)
        export NVM_DIR="$HOME/.nvm"
        mkdir -p "$NVM_DIR" >/dev/null 2>&1 || true
        if [ ! -s "$NVM_DIR/nvm.sh" ]; then
          echo "Installing nvm (Node Version Manager) to $NVM_DIR ..."
          curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash -s -- --no-use || true
        fi
        # shellcheck disable=SC1090
        [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
        if command -v nvm >/dev/null 2>&1; then
          echo "Installing Node.js LTS via nvm..."
          nvm install 18 >/dev/null 2>&1 || nvm install --lts >/dev/null 2>&1 || true
          nvm use 18 >/dev/null 2>&1 || nvm use --lts >/dev/null 2>&1 || true
        else
          echo "⚠️  Failed to set up nvm automatically. Please install Node.js 18+ from https://nodejs.org/"
        fi
    fi
    if ! command -v node &> /dev/null; then
        echo "❌ Node.js still not available. Please install Node.js 18+ (Homebrew: brew install node, or nvm)."
        exit 1
    fi
fi

# Check Node.js version
NODE_VERSION=$(node --version)
NODE_MAJOR=$(echo $NODE_VERSION | cut -d. -f1 | tr -d 'v')
if [ "$NODE_MAJOR" -lt 18 ]; then
    echo "❌ Node.js version $NODE_VERSION detected. This tool requires Node.js 18.0 or higher."
    echo "Please update Node.js (Homebrew: brew upgrade node, or nvm install 18) and try again."
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