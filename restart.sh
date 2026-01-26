#!/bin/bash
cd "$(dirname "$0")"
source .env 2>/dev/null || { echo "ERROR: .env file not found"; exit 1; }
[ -z "$AUTH_TOKEN" ] && { echo "ERROR: AUTH_TOKEN not set in .env"; exit 1; }

# Stop PM2 if it's managing this app
pm2 stop claude-remote 2>/dev/null
pm2 delete claude-remote 2>/dev/null

# Kill any remaining server processes
lsof -ti :3456 | xargs kill -9 2>/dev/null
sleep 1

# Clear log and start server
rm -f server.log
touch server.log
AUTH_TOKEN=$AUTH_TOKEN nohup node server.js > server.log 2>&1 &
sleep 2
curl -sf http://localhost:3456/health || { echo "ERROR: Server failed to start"; cat server.log; exit 1; }
echo "Server running on http://localhost:3456"

# Kill and restart cloudflared to ensure clean connection
pkill -9 cloudflared 2>/dev/null
sleep 1
echo "Starting cloudflared tunnel..."
nohup cloudflared tunnel run > /tmp/cloudflared.log 2>&1 &
sleep 3
if pgrep -q cloudflared; then
  echo "Tunnel active at https://claude.dazztrazak.com"
else
  echo "ERROR: cloudflared failed to start"
  cat /tmp/cloudflared.log
  exit 1
fi
