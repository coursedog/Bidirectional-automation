#!/bin/bash

echo "🚀 Bi-directional Tests Automation Tool - Unix/Linux/macOS"
echo "=========================================================="

# Optional: Auto-update from Git if available
if command -v git &> /dev/null; then
  if git rev-parse --is-inside-work-tree &> /dev/null; then
    if git remote get-url origin &> /dev/null; then
      if [ -z "$(git status --porcelain)" ]; then
        echo "🔄 Updating project (git pull --ff-only)..."
        if ! git pull --ff-only; then
          echo "⚠️  git pull failed. Continuing without updating."
        fi
      else
        echo "⚠️  Local changes detected. Skipping auto-update to avoid merge conflicts."
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