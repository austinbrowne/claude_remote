#!/bin/bash
# Start the Claude Remote server

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Check prerequisites
command -v node >/dev/null 2>&1 || { echo "ERROR: Node.js not installed"; exit 1; }

# Linux-specific checks
if [[ "$(uname)" == "Linux" ]]; then
  command -v tmux >/dev/null 2>&1 || { echo "ERROR: tmux not installed. Install with: sudo dnf install tmux"; exit 1; }
  if ! tmux list-sessions &>/dev/null; then
    echo "WARNING: No tmux server running. Start a session with: tmux new -s claude"
  fi
fi

# Check if already running (lsof on Linux, ss as fallback)
if command -v lsof >/dev/null 2>&1; then
  if lsof -i :3456 > /dev/null 2>&1; then
    echo "Server already running on port 3456. Use ./restart.sh to restart."
    exit 1
  fi
elif command -v ss >/dev/null 2>&1; then
  if ss -tlnp | grep -q ':3456 ' 2>/dev/null; then
    echo "Server already running on port 3456. Use ./restart.sh to restart."
    exit 1
  fi
fi

# Load token from .env if exists
# [CONS-014] Use source instead of unsafe export $(...) pattern
if [ -f .env ]; then
  set -a
  source .env
  set +a
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

SERVER_UP=false
if command -v lsof >/dev/null 2>&1 && lsof -i :3456 > /dev/null 2>&1; then
  SERVER_UP=true
elif command -v ss >/dev/null 2>&1 && ss -tlnp | grep -q ':3456 ' 2>/dev/null; then
  SERVER_UP=true
fi

if [ "$SERVER_UP" = true ]; then
  echo "Server started on http://localhost:3456"
else
  echo "Failed to start server"
  exit 1
fi
