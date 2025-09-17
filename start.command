#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
# Ensure the main script is executable
chmod +x ./start.sh 2>/dev/null
# Run the main mac script
exec ./start.sh
