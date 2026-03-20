---
title: Migrate Mac Mini to tmux Backend
status: approved
tier: minimal
created: 2026-03-19
tags: [deployment, tmux, mac-mini, headless]
---

# Migrate Mac Mini to tmux Backend

## Problem

The Mac Mini runs Claude Remote with the iTerm/AppleScript adapter, which requires a logged-in GUI session. If the Mac Mini reboots or the user logs out, session discovery and command injection break silently.

## Solution

Switch to the tmux adapter via `CLAUDE_REMOTE_PLATFORM=linux` env var. Run Claude sessions inside tmux. Use LaunchDaemons to ensure tmux, the Claude Remote server, and cloudflared all survive reboots without a GUI login.

When physically at the Mac Mini, iTerm's native tmux integration (`tmux -CC attach`) provides the same tab-based UX.

## Implementation Steps

1. **Install tmux:** `brew install tmux`

2. **Update `.env`:**
   ```
   AUTH_TOKEN=<existing>
   # Forces tmux adapter instead of iTerm/AppleScript (works on macOS with tmux installed)
   CLAUDE_REMOTE_PLATFORM=linux
   ```
   Ensure permissions: `chmod 600 .env`

3. **Create persistent tmux session:** `tmux new-session -d -s claude`

4. **Create `run-server.sh` wrapper** (sources `.env` for LaunchDaemon, waits for tmux):
   ```bash
   #!/bin/bash
   cd "$(dirname "$0")"

   # Load environment (AUTH_TOKEN, CLAUDE_REMOTE_PLATFORM)
   set -a; source .env; set +a

   # Wait for tmux server to be ready (may start after this daemon)
   for i in $(seq 1 30); do
     /opt/homebrew/bin/tmux list-sessions >/dev/null 2>&1 && break
     sleep 1
   done

   exec /opt/homebrew/bin/node server.js
   ```
   Permissions: `chmod 755 run-server.sh`

5. **Create LaunchDaemon for tmux server** — `/Library/LaunchDaemons/com.user.tmux-server.plist`:
   - `UserName: dazz` (run as user, not root)
   - `RunAtLoad: true`, `KeepAlive: false`
   - `ProgramArguments: [/opt/homebrew/bin/tmux, new-session, -d, -s, claude]`

6. **Create LaunchDaemon for Claude Remote server** — `/Library/LaunchDaemons/com.user.claude-remote.plist`:
   - `UserName: dazz` (run as user, not root)
   - `RunAtLoad: true`, `KeepAlive: true`
   - `ProgramArguments: [/bin/bash, /Users/dazz/Git_Repos/claude_remote/run-server.sh]`

7. **Verify cloudflared is daemon-managed:**
   ```bash
   sudo launchctl list | grep cloudflare
   ```
   If not listed, it needs a LaunchDaemon too. It was installed via `sudo cloudflared service install` so it should already be managed.

8. **Update `restart.sh` for daemon mode:**
   Detect if the LaunchDaemon is loaded and use `launchctl stop/start` instead of killing processes directly. Fall back to the old behavior if not daemon-managed.

9. **Start a Claude session in tmux and verify:**
   ```bash
   tmux new-window -t claude 'claude --resume'
   ```
   Check web UI — verify server log shows `[Platform] Using linux-tmux adapter` (not macOS/AppleScript).

10. **Test headless operation:**
    - Log out of GUI session on Mac Mini
    - From phone: open `mini.dazztrazak.com`, verify session visible
    - Inject a command, verify it reaches tmux
    - From laptop: `ssh mini 'tmux list-sessions'` — verify sessions alive

11. **Test reboot survival:**
    - Reboot Mac Mini
    - Wait 60 seconds
    - Verify: `curl -sf https://mini.dazztrazak.com/health`
    - Verify: `ssh mini 'tmux list-sessions'`

## Starting New Claude Sessions

After a session ends, start a new one from anywhere:

- **From phone/web UI:** Not yet supported (future feature)
- **From SSH:** `ssh mini 'tmux new-window -t claude "claude --resume"'`
- **From Mac Mini terminal:** `tmux new-window -t claude 'claude --resume'`
- **From iTerm (attached):** Cmd+T creates a new tmux window automatically

## Rollback Procedure

If the tmux migration fails:

1. Unload the daemons:
   ```bash
   sudo launchctl unload /Library/LaunchDaemons/com.user.tmux-server.plist
   sudo launchctl unload /Library/LaunchDaemons/com.user.claude-remote.plist
   ```
2. Remove `CLAUDE_REMOTE_PLATFORM=linux` from `.env`
3. Start the server manually: `./restart.sh`
4. Resume using iTerm/AppleScript as before

## Affected Files

| File | Change |
|------|--------|
| `.env` | Add `CLAUDE_REMOTE_PLATFORM=linux` with comment, ensure `chmod 600` |
| `run-server.sh` | **New** — wrapper with tmux readiness check, `chmod 755` |
| `restart.sh` | Update to detect daemon mode and use `launchctl` |
| `/Library/LaunchDaemons/com.user.tmux-server.plist` | **New** — tmux persistence, `UserName: dazz` |
| `/Library/LaunchDaemons/com.user.claude-remote.plist` | **New** — server persistence, `UserName: dazz`, `KeepAlive: true` |

## Acceptance Criteria

- [ ] `tmux list-sessions` shows the `claude` session
- [ ] Server log shows `[Platform] Using linux-tmux adapter` on startup
- [ ] Claude Remote discovers sessions via `tmux list-panes` (not AppleScript)
- [ ] Command injection works via `tmux send-keys`
- [ ] `mini.dazztrazak.com` works from phone **with no GUI session active**
- [ ] After reboot: tmux, server, and cloudflared all start automatically (verified by health check)
- [ ] iTerm `tmux -CC attach` works with native tabs
- [ ] `restart.sh` detects daemon mode and uses `launchctl` instead of killing processes
- [ ] `.env` has `chmod 600`, `run-server.sh` has `chmod 755`

## Risks

| Risk | Mitigation |
|------|------------|
| LaunchDaemon starts before Homebrew PATH available | Wrapper uses absolute paths (`/opt/homebrew/bin/node`, `/opt/homebrew/bin/tmux`) |
| Claude Remote starts before tmux is ready | `run-server.sh` polls `tmux list-sessions` up to 30s before starting node |
| tmux session ends with no Claude sessions | Start new ones via SSH: `ssh mini 'tmux new-window -t claude "claude --resume"'` |
| `restart.sh` conflicts with LaunchDaemon | Updated to detect and delegate to `launchctl stop/start` |
| LaunchDaemon misconfigured after reboot | Documented rollback: `launchctl unload` + revert `.env` + `./restart.sh` |
| `source .env` executes shell code | `.env` contains only `KEY=value` lines; `chmod 600` prevents tampering by other users |
| `CLAUDE_REMOTE_PLATFORM=linux` confusing on macOS | Comment in `.env` explains it forces the tmux adapter |
