#!/bin/bash
# Stop the Claude Remote server

echo "Stopping Claude Remote server..."

# Find PID using port 3456
PID=$(lsof -ti :3456 2>/dev/null)

if [ -z "$PID" ]; then
  echo "Server not running"
  exit 0
fi

kill $PID 2>/dev/null
sleep 1

# Check if still running
if lsof -i :3456 > /dev/null 2>&1; then
  echo "Force killing..."
  kill -9 $PID 2>/dev/null
  sleep 1
fi

echo "Server stopped"
