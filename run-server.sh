#!/bin/bash
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
export HOME="/Users/dazz"

# Enforce .env permissions (never use set -x — would leak AUTH_TOKEN)
PERMS=$(stat -f '%A' .env 2>/dev/null)
if [ "$PERMS" != "600" ]; then
  echo "ERROR: .env permissions are $PERMS (must be 600)" >&2
  exit 1
fi

set -a; source .env; set +a

exec /opt/homebrew/bin/node server.js
