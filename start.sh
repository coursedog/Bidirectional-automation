#!/bin/bash

echo "🚀 Bi-directional Tests Automation Tool - Unix/Linux/macOS"
echo "=========================================================="

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