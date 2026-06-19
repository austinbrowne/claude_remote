#!/bin/bash
# One-time setup: invisible tmux via iTerm Dynamic Profile
# Safe to re-run (idempotent)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PROFILE_SOURCE="$SCRIPT_DIR/iterm-claude-remote-profile.json"
PROFILE_DEST="$HOME/Library/Application Support/iTerm2/DynamicProfiles/claude-remote.json"
ENV_FILE="$PROJECT_DIR/.env"
LAUNCH_AGENT_DIR="$HOME/Library/LaunchAgents"
LAUNCH_AGENT="$LAUNCH_AGENT_DIR/com.clauderemote.server.plist"
LOG_DIR="$HOME/Library/Logs/ClaudeRemote"

ok() { echo "  [OK] $1"; }
warn() { echo "  [WARN] $1"; }
fail() { echo "  [FAIL] $1"; exit 1; }

echo "=== Claude Remote: iTerm + tmux Setup ==="
echo ""

# ── Step 1: Prerequisites ──────────────────────────────────
echo "Step 1: Checking prerequisites..."

command -v tmux >/dev/null 2>&1 || fail "tmux not installed. Run: brew install tmux"
ok "tmux installed ($(tmux -V))"

if [ -d "/Applications/iTerm.app" ]; then
  ITERM_VERSION=$(defaults read /Applications/iTerm.app/Contents/Info.plist CFBundleShortVersionString 2>/dev/null || echo "unknown")
  ok "iTerm2 installed (v$ITERM_VERSION)"
else
  fail "iTerm2 not installed. Download from https://iterm2.com"
fi

# Check auto-login
AUTO_LOGIN=$(defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser 2>/dev/null || echo "")
if [ -n "$AUTO_LOGIN" ]; then
  ok "Auto-login enabled (user: $AUTO_LOGIN)"
else
  warn "Auto-login NOT enabled — headless reboot recovery will NOT work"
  warn "  Enable: System Settings → Users & Groups → Automatic login"
  warn "  Trade-off: disables login screen (physical security risk)"
fi

echo ""

# ── Step 2: Install iTerm Dynamic Profile ──────────────────
echo "Step 2: Installing iTerm Dynamic Profile..."

mkdir -p "$(dirname "$PROFILE_DEST")"

if [ -f "$PROFILE_DEST" ]; then
  # Remove immutable flag if set, then overwrite
  chflags nouchg "$PROFILE_DEST" 2>/dev/null || true
fi

cp "$PROFILE_SOURCE" "$PROFILE_DEST"
chflags uchg "$PROFILE_DEST" 2>/dev/null || true
ok "Profile installed: $PROFILE_DEST"
ok "Profile set immutable (chflags uchg)"

echo ""

# ── Step 3: Update .env ───────────────────────────────────
echo "Step 3: Configuring .env..."

if [ ! -f "$ENV_FILE" ]; then
  fail ".env not found at $ENV_FILE — run initial setup first (see README)"
fi

# Safe key-value update: update if exists, append if not
update_env_key() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "$ENV_FILE"; then
    # macOS sed -i requires '' argument
    sed -i '' "s|^${key}=.*|${key}=${value}|" "$ENV_FILE"
    ok "Updated $key in .env"
  else
    echo "${key}=${value}" >> "$ENV_FILE"
    ok "Added $key to .env"
  fi
}

update_env_key "CLAUDE_REMOTE_ADAPTER" "tmux"

# Verify AUTH_TOKEN still present
if ! grep -q "^AUTH_TOKEN=" "$ENV_FILE"; then
  fail "AUTH_TOKEN missing from .env after update!"
fi
ok "AUTH_TOKEN verified present"

# Enforce permissions
chmod 600 "$ENV_FILE"
ok ".env permissions set to 600"

echo ""

# ── Step 4: Create LaunchAgent ─────────────────────────────
echo "Step 4: Setting up LaunchAgent for server auto-start..."

mkdir -p "$LAUNCH_AGENT_DIR"
mkdir -p "$LOG_DIR"
chmod 700 "$LOG_DIR"

cat > "$LAUNCH_AGENT" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.clauderemote.server</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${PROJECT_DIR}/run-server.sh</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${PROJECT_DIR}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${LOG_DIR}/server.log</string>
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/server.err</string>
</dict>
</plist>
PLIST

chmod 444 "$LAUNCH_AGENT"
ok "LaunchAgent created: $LAUNCH_AGENT (read-only)"
ok "Logs: $LOG_DIR/"

echo ""

# ── Step 5: Create run-server.sh ───────────────────────────
echo "Step 5: Creating server wrapper..."

cat > "$PROJECT_DIR/run-server.sh" << 'WRAPPER'
#!/bin/bash
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
export HOME="$HOME"

# Enforce .env permissions
PERMS=$(stat -f '%A' .env 2>/dev/null)
if [ "$PERMS" != "600" ]; then
  echo "ERROR: .env permissions are $PERMS (must be 600)" >&2
  exit 1
fi

# Source environment (never use set -x — would leak AUTH_TOKEN)
set -a; source .env; set +a

# Wait for tmux server (max 30s)
for i in $(seq 1 30); do
  /opt/homebrew/bin/tmux list-sessions >/dev/null 2>&1 && break
  if [ "$i" -eq 30 ]; then
    echo "ERROR: tmux not available after 30s" >&2
    exit 1
  fi
  sleep 1
done

exec /opt/homebrew/bin/node server.js
WRAPPER

# Fix HOME in the wrapper to the actual user
sed -i '' "s|export HOME=\"\$HOME\"|export HOME=\"$HOME\"|" "$PROJECT_DIR/run-server.sh"
chmod 755 "$PROJECT_DIR/run-server.sh"
ok "run-server.sh created"

echo ""

# ── Step 6: Add iTerm to Login Items ───────────────────────
echo "Step 6: Adding iTerm to Login Items..."

# osascript can add login items
osascript -e 'tell application "System Events" to make login item at end with properties {name:"iTerm", path:"/Applications/iTerm.app", hidden:false}' 2>/dev/null && \
  ok "iTerm added to Login Items" || \
  warn "Could not add iTerm to Login Items — add manually: System Settings → General → Login Items"

echo ""

# ── Step 7: Load LaunchAgent ───────────────────────────────
echo "Step 7: Loading LaunchAgent..."

# Unload first if already loaded (idempotent)
launchctl unload "$LAUNCH_AGENT" 2>/dev/null || true
launchctl load "$LAUNCH_AGENT" 2>/dev/null && \
  ok "LaunchAgent loaded" || \
  warn "Could not load LaunchAgent — run: launchctl load $LAUNCH_AGENT"

echo ""

# ── Summary ─────────────────────────────────────────────────
echo "=== Setup Complete ==="
echo ""
echo "One manual step remaining:"
echo "  Open iTerm → Preferences → Profiles"
echo "  Select 'Claude Remote' → Other Actions → Set as Default"
echo ""
echo "Then open a new iTerm tab — it will be a tmux window."
echo "Run 'claude --effort high' and check your phone."
echo ""
echo "Done! Your iTerm tabs are now tmux windows."
echo "Sessions survive crashes and reboots. You never need to type 'tmux'."
