#!/bin/bash
# Start the Claude Remote server

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Check if already running
if lsof -i :3456 > /dev/null 2>&1; then
  echo "Server already running on port 3456. Use ./restart.sh to restart."
  exit 1
fi

# Load token from .env if exists
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
fi

if [ -z "$AUTH_TOKEN" ]; then
  echo "ERROR: AUTH_TOKEN not set"
  echo "Either:"
  echo "  1. Create .env file with: AUTH_TOKEN=your_token_here"
  echo "  2. Run: AUTH_TOKEN=your_token ./start.sh"
  echo ""
  echo "Generate a token with: openssl rand -hex 32"
  exit 1
fi

echo "Starting Claude Remote server..."
AUTH_TOKEN="$AUTH_TOKEN" node server.js &
sleep 2

if lsof -i :3456 > /dev/null 2>&1; then
  echo "Server started on http://localhost:3456"
else
  echo "Failed to start server"
  exit 1
fi
