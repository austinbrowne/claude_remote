---
title: Multi-Machine Deployment with Server Switcher
status: approved
tier: standard
created: 2026-03-10
tags: [feature, ios, deployment, cloudflared, multi-machine]
---

# Multi-Machine Deployment with Server Switcher

## Problem

Claude Remote runs on a laptop at `claude.dazztrazak.com` via cloudflared tunnel. A second instance is needed on a Mac Mini, but:
1. A single domain can only point to one tunnel — need a subdomain strategy
2. The iOS app only connects to one server at a time with no quick-switch capability

## Goals

1. Deploy Claude Remote on Mac Mini with its own cloudflared tunnel at `mini.claude.dazztrazak.com`
2. Add a saved servers list to the iOS app for one-tap switching between machines
3. Keep the existing Keychain-per-server token storage

## Solution

**Infrastructure:** Subdomain-per-machine with separate cloudflared tunnels.

**iOS App:** Add a `SavedServer` model and server picker UI. Saved servers persisted in UserDefaults (names only; URLs normalized). Tokens remain in Keychain keyed by canonical URL. On tap, the app validates the target (token exists, URL valid) before disconnecting, then reconnects.

## Technical Approach

### New Model — `SavedServer`

```swift
struct SavedServer: Codable, Identifiable, Equatable, Hashable {
    let id: UUID          // Stable identity — survives URL edits
    var name: String      // e.g., "Laptop", "Mac Mini"
    var url: String       // Canonical: lowercase host, no trailing slash, https:// enforced for remote
}
```

UUID is used as identity (not URL) so that editing a server's URL doesn't orphan the Keychain entry or break active-server tracking.

### URL Normalization

All URLs are canonicalized before storage and Keychain operations:
- Lowercase the host component
- Strip trailing slash
- Enforce `https://` scheme for non-localhost hosts (reject `http://` for remote)
- Allow `http://` only for `localhost` / `127.0.0.1`

This prevents duplicate/orphaned Keychain entries from trivial URL variations.

### Storage

- **Server list:** `UserDefaults` via `SettingsStore` — JSON-encoded `[SavedServer]` array. `SettingsStore` is the single source of truth; `AppState` does NOT hold a duplicate `savedServers` property. Views read from `SettingsStore` directly.
- **Tokens:** Keychain keyed by canonical URL (existing behavior, unchanged).

### AppCoordinator State Machine

```
                    ┌──────────────┐
         ┌────────▶│ disconnected │◀────────┐
         │         └──────┬───────┘         │
         │                │ connect()       │ disconnect()
         │                ▼                 │
         │         ┌──────────────┐         │
  timeout/fail     │  connecting  │─────────┘
         │         └──────┬───────┘   (on failure)
         │                │ auth success
         │                ▼
         │         ┌──────────────┐
         └─────────│  connected   │
                   └──────┬───────┘
                          │ switchServer()
                          ▼
                   ┌──────────────┐
                   │  switching   │ (validate → disconnect → connect)
                   └──────────────┘
```

States: `disconnected`, `connecting`, `connected`, `switching`

- `switchServer(_:)` can only be called from `connected` state
- During `switching`, the server list is disabled (no concurrent switches)
- If switch fails, revert to previous server automatically

### Connection Flow on Switch — Validate Before Disconnect

```swift
func switchServer(_ server: SavedServer) async {
    // 1. VALIDATE FIRST (still connected to old server)
    let canonicalURL = URLHelper.canonicalize(server.url)
    guard let wsURL = WebSocketService.webSocketURL(from: canonicalURL) else {
        state.showToast("Invalid server URL", icon: "xmark.circle", style: .error)
        return
    }
    guard let token = keychain.load(for: canonicalURL) else {
        // No token — navigate to AuthView with URL pre-filled
        state.serverURL = canonicalURL
        state.isAuthenticated = false
        return
    }

    // 2. Enter switching state (disables UI)
    connectionState = .switching
    let previousServer = currentServer

    // 3. Disconnect from current
    await disconnect()

    // 4. Connect to new
    state.serverURL = canonicalURL
    connect(url: wsURL, token: token)

    // 5. Await result with timeout
    let connected = await awaitConnection(timeout: 10)
    if !connected {
        // ROLLBACK — reconnect to previous server
        state.showToast("Could not reach \(server.name)", icon: "wifi.slash", style: .error)
        state.serverURL = previousServer.url
        if let prevToken = keychain.load(for: previousServer.url),
           let prevWS = WebSocketService.webSocketURL(from: previousServer.url) {
            connect(url: prevWS, token: prevToken)
        }
    }
    connectionState = connected ? .connected : .disconnected
}
```

All switch logic lives in `AppCoordinator` — views call a single method and react to state changes. No branching logic in views.

### UI Integration

#### AuthView — Saved Servers List

Below the manual URL/token form, a "Saved Servers" section:

- **With servers:** List of saved servers. Tap to connect (auto-fills URL, loads token from Keychain, calls `connectAction()`).
- **Empty state:** "No saved servers yet" label with an "Add Server" button visible.
- **"Save Current" button:** Appears after successful manual connection. Tapping it presents a name prompt sheet (defaults to hostname extracted from URL, e.g., "claude" from `https://claude.dazztrazak.com`). Validates URL format before allowing save. Does not trigger a separate connection.

**Missing-token flow:** When tapping a saved server with no Keychain token:
1. URL pre-fills in the server URL field
2. Token field focuses with helper text: "Enter token to connect to [server name]"
3. Tapping "Connect" saves the token to Keychain keyed by the canonical URL, then proceeds with normal connection

#### SettingsView — Servers Section

New section above "Connection":

- **With servers:** List rows showing server name + URL. Active server has a checkmark. Tap to switch (calls `coordinator.switchServer()`). Swipe to delete. `EditButton` in toolbar for accessibility (delete without swipe). Tap row → edit sheet with name field for rename.
- **Empty state:** "No saved servers" with "Add Server" row.
- **"Add Server" row:** Always visible at bottom. Navigates to AuthView.
- **During switch:** Entire section disabled. Spinner on the selected row. Active indicator clears from old server immediately, appears on new server only after connect succeeds.

#### Delete Active Server Flow

1. Disconnect from the server
2. Remove from saved servers list
3. Navigate to AuthView
4. URL and token fields are cleared
5. Saved servers list shown (if any remain)
6. No auto-connect

#### Rename Flow

Tap server row in SettingsView → edit sheet with name field → validate non-empty (max 50 chars, strip control characters) → save on confirm.

### Duplicate Prevention

On save, check if a server with the same canonical URL already exists. If so, offer to update the existing entry's name rather than creating a duplicate.

## Implementation Steps

1. **Add `SavedServer` model** — `Models/SavedServer.swift` with Codable, Identifiable, Equatable, Hashable
2. **Add URL normalization helper** — canonical URL function (lowercase host, strip trailing slash, enforce https for remote)
3. **Add persistence to `SettingsStore`** — `saveSavedServers(_:)`, `loadSavedServers()` with JSON decode error handling (return empty array on corrupt data)
4. **Add connection state enum to `AppCoordinator`** — `disconnected`, `connecting`, `connected`, `switching`
5. **Add `switchServer(_:)` to `AppCoordinator`** — validate-before-disconnect, 10s timeout, rollback on failure, debounce (reject if already switching)
6. **Add saved servers list to `AuthView`** — server list with empty state, tap to connect, missing-token flow with pre-fill + focus, "Save Current" button with name prompt
7. **Add "Servers" section to `SettingsView`** — server list with active indicator, EditButton for accessibility, tap to switch, swipe to delete, rename via edit sheet, add server row
8. **Add loading/transition states** — disable server list during switch, spinner on selected row, clear/set active indicator correctly
9. **Wire up delete-active-server flow** — disconnect → remove → navigate to AuthView with cleared fields
10. **Add duplicate URL detection** — check on save, offer to update existing entry

## Affected Files

| File | Change |
|------|--------|
| `Models/SavedServer.swift` | **New** — model with UUID, name, url |
| `Utilities/URLHelper.swift` | **New** — URL canonicalization + validation |
| `Utilities/SettingsStore.swift` | Add saved servers persistence (single source of truth) |
| `Views/AuthView.swift` | Saved servers list, empty state, missing-token flow, save button |
| `Views/SettingsView.swift` | Servers section with switcher, rename, edit mode, loading states |
| `Services/AppCoordinator.swift` | Connection state machine, `switchServer(_:)` with validate/rollback |

`AppState` does NOT get a `savedServers` property — `SettingsStore` is the sole owner.

## Mac Mini Deployment Steps

1. **Prerequisites:** Install Node.js, iTerm2, Claude Code, cloudflared (`brew install cloudflared`)
2. **Clone and configure:**
   ```bash
   git clone <repo-url> ~/Git_Repos/claude_remote
   cd ~/Git_Repos/claude_remote && npm install
   openssl rand -hex 32  # Generate unique token — do NOT reuse laptop token
   echo "AUTH_TOKEN=<generated>" > .env
   chmod 600 .env
   ```
3. **Verify `.env` is in `.gitignore`** (should already be, but confirm)
4. **Create cloudflared tunnel** in Cloudflare Dashboard → Networks → Tunnels → Create
   - Name: `mac-mini`
   - Run the install command on the Mac Mini
   - Add Public Hostname: `mini.claude.dazztrazak.com` → `http://localhost:3456`
   - Verify Cloudflare SSL mode is "Full (Strict)" for the domain
5. **Set up auto-start:**
   - cloudflared: LaunchAgent (created by dashboard install command)
   - Node.js server: Create a LaunchAgent for `node server.js` or use pm2
6. **Ensure GUI login session is active** — iTerm + AppleScript require a logged-in GUI session. Configure Mac Mini for auto-login, or use Screen Sharing. If the Mac Mini restarts without a GUI session, the server will start but session discovery and command injection will fail silently.
7. **Start and verify:**
   ```bash
   ./restart.sh
   curl -sf https://mini.claude.dazztrazak.com/health
   ```

## Spec-Flow Analysis

### Happy path
User taps saved server in SettingsView → server list disables, spinner appears on row → app validates token exists and URL is valid → disconnects from current → connects to new → active indicator moves to new server → sessions load from new machine.

### Error flows

| Scenario | Behavior |
|----------|----------|
| **No token in Keychain** | Navigate to AuthView. URL pre-fills, token field focuses with helper text. After manual connect, prompt to save as named server. |
| **Server unreachable (during switch)** | 10s timeout → toast "Could not reach [name]" → auto-rollback to previous server → active indicator reverts. |
| **Server unreachable (initial connect)** | Existing reconnection logic with visible "Disconnected" status in SettingsView. |
| **Delete active server** | Disconnect → remove from list → AuthView with cleared fields. If other servers remain, they are listed. |
| **Delete inactive server** | Remove from list. Keychain token preserved (in case re-added later). |
| **Concurrent switch (rapid taps)** | Rejected — server list disabled while in `switching` state. |
| **Edit URL of active server** | Disconnect, re-prompt for token (Keychain key changed with URL). |
| **Edit URL of inactive server** | Update UserDefaults. Old Keychain entry preserved; new token prompted on next connect. |
| **Duplicate URL on save** | Offer to update existing entry's name instead of creating duplicate. |
| **Corrupt UserDefaults data** | `loadSavedServers()` returns empty array. User can re-add servers manually. |
| **App backgrounded during switch** | Consistent with existing backgrounding behavior — connection attempt continues; on foreground, state reflects outcome. |

### Empty states

| Context | Display |
|---------|---------|
| **AuthView, no saved servers** | "No saved servers yet" + Add Server button |
| **SettingsView, no saved servers** | "No saved servers" + Add Server row |
| **AuthView, saved servers exist** | List of servers with tap-to-connect |

## Acceptance Criteria

- [ ] Mac Mini runs Claude Remote at `mini.claude.dazztrazak.com`
- [ ] iOS app shows list of saved servers in AuthView and SettingsView
- [ ] Tapping a saved server validates first, then connects (no stranded state)
- [ ] Active server is visually indicated (checkmark) only after connection succeeds
- [ ] Servers can be added (with name prompt), renamed (edit sheet), and deleted (swipe or edit mode)
- [ ] Switching servers preserves the token for the previous server in Keychain
- [ ] Failed switch rolls back to previous server automatically
- [ ] Server list is disabled during switch (no concurrent switches)
- [ ] Missing token navigates to AuthView with URL pre-filled and token field focused
- [ ] URLs are normalized (https enforced for remote, lowercase host, no trailing slash)
- [ ] Both instances work simultaneously and independently
- [ ] Mac Mini has auto-login configured for GUI session (iTerm/AppleScript requirement)

## Risks

| Risk | Mitigation |
|------|------------|
| Switch fails mid-flight | Validate-before-disconnect + 10s timeout + auto-rollback to previous server |
| URL variations cause Keychain misses | Canonical URL normalization on all storage and lookup operations |
| Mac Mini restarts without GUI session | Document auto-login requirement; add health check monitoring |
| Saved server URL edited to malicious target | HTTPS enforced for remote; token only sent after URL validation; editing active server forces re-auth |
| Async disconnect/reconnect race | State machine enforces sequential transitions; `switching` state blocks concurrent operations |

## Test Strategy

### Unit Tests
1. `SavedServer` Codable round-trip + Equatable/Hashable
2. URL normalization: trailing slash, case, scheme enforcement, localhost exception
3. `SettingsStore` save/load saved servers + corrupt data recovery (empty array)
4. `switchServer` rejects when not in `connected` state
5. Duplicate URL detection on save

### Integration Tests
6. Switch with rollback: mock unreachable server, verify revert to previous
7. Concurrent switch rejection: call `switchServer` twice rapidly, verify second is rejected
8. Missing-token flow: verify navigation to AuthView with pre-filled URL

### Manual Tests
9. Add two servers (laptop + Mac Mini), switch between them, verify sessions load
10. Delete active server → verify AuthView shown with cleared fields
11. Edit active server URL → verify disconnect + re-auth prompt
12. Tap saved server with no Keychain token → verify token prompt flow
13. Switch to offline server → verify timeout, error toast, rollback
