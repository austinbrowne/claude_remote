#!/bin/bash
# Wrapper for LaunchDaemon — sources .env and waits for tmux before starting server.
cd "$(dirname "$0")"

# Ensure Homebrew binaries are in PATH (LaunchDaemons don't inherit user PATH)
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
export HOME="/Users/dazz"

# Load environment (AUTH_TOKEN, CLAUDE_REMOTE_PLATFORM)
set -a; source .env; set +a

# Wait for tmux server to be ready (may start after this daemon)
for i in $(seq 1 30); do
  /opt/homebrew/bin/tmux list-sessions >/dev/null 2>&1 && break
  sleep 1
done

exec /opt/homebrew/bin/node server.js
