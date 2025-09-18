#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
chmod +x ./start.sh 2>/dev/null

while true; do
  ./start.sh
  status=$?
  echo ""
  read -p "Run again? (y/n): " again
  if [[ ! $again =~ ^[Yy]$ ]]; then
    exit $status
  fi
  echo ""
done
