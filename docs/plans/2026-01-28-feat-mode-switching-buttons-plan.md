---
title: Mode Switching Buttons
type: feat
date: 2026-01-28
---

# Mode Switching Buttons

## Overview

Add buttons to switch between Plan Mode and Allow Edits mode from the mobile app.

## Solution

| Button | Command | Method |
|--------|---------|--------|
| 📋 Plan | `/plan` | Text injection (works in background) |
| ✏️ Edits | Shift+Tab | Legacy AppleScript (activates iTerm) |

## Implementation

### 1. Add Mode Toggle Action on Server

**File:** `server.js` - add new WebSocket action handler (~line 1200)

```javascript
case 'mode_toggle':
  // Send Shift+Tab to cycle modes (requires activating iTerm)
  const toggleSession = activeSessions.get(msg.sessionId)?.session;
  if (!toggleSession) {
    ws.send(JSON.stringify({ type: 'mode_toggle_result', success: false, error: 'Session not found' }));
    break;
  }
  sendModeToggle(toggleSession.tty, (err) => {
    ws.send(JSON.stringify({
      type: 'mode_toggle_result',
      success: !err,
      error: err?.message
    }));
  });
  break;
```

### 2. Add sendModeToggle Function

**File:** `server.js` - add after `sendEscapeKeyToTty` function (~line 1390)

```javascript
function sendModeToggle(tty, callback) {
  // Shift+Tab requires System Events, which needs iTerm activated
  const appleScript = `
    tell application "iTerm2"
      activate
      delay 0.1
    end tell
    tell application "System Events"
      key code 48 using shift down
    end tell
  `;

  exec(`osascript -e '${appleScript.replace(/'/g, "'\\''")}'`, (err) => {
    if (callback) callback(err);
  });
}
```

### 3. Add Buttons to Quick Actions

**File:** `public/index.html` - modify quick-actions div (~line 1103)

```html
<div class="quick-actions">
  <button class="quick-btn" onclick="sendPreset('/plan')">📋 Plan</button>
  <button class="quick-btn" onclick="sendModeToggle()">✏️ Edits</button>
  <button class="quick-btn" onclick="sendPreset('/clear')">🧹 Clear</button>
  <button class="quick-btn" onclick="sendPreset('/compact')">📦 Compact</button>
  <button class="quick-btn" onclick="sendPreset('/status')">📊 Status</button>
  <button class="quick-btn" onclick="sendPreset('y')">✓ Yes</button>
  <button class="quick-btn danger" onclick="sendEscape()">⎋ Cancel</button>
</div>
```

### 4. Add sendModeToggle Function in Client

**File:** `public/index.html` - add after `sendEscape` function (~line 2108)

```javascript
function sendModeToggle() {
  wsSend({ action: 'mode_toggle', sessionId: currentSessionId });
  showToast('Toggling mode...', 'success');
}
```

## Files to Modify

| File | Changes |
|------|---------|
| `server.js:1200` | Add `mode_toggle` WebSocket action handler |
| `server.js:1390` | Add `sendModeToggle()` function |
| `public/index.html:1103` | Add Plan and Edits buttons |
| `public/index.html:2108` | Add `sendModeToggle()` client function |

## Behavior

1. **📋 Plan button**: Sends `/plan` text command → enters plan mode (works in background)
2. **✏️ Edits button**: Sends Shift+Tab via AppleScript → cycles to allow-edits mode (activates iTerm briefly)

## Verification

1. Open mobile app, connect to session
2. Tap 📋 Plan → should see "Entering plan mode" in Claude output
3. Tap ✏️ Edits → iTerm activates briefly, mode indicator changes
4. Verify both work when session is in background tab
