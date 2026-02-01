---
title: "feat: Local notifications for session activity"
type: feat
date: 2026-02-01
---

# feat: Local notifications for session activity

## Overview

Add iOS local notifications so the user is alerted to session events when the app is backgrounded. Notifications fire for all status changes: permission requests, questions, work starting, work completing, and errors. Each notification shows the session name and a relevant summary.

## Problem Statement

When the user backgrounds the app, they have no way of knowing when Claude needs input (permission, question) or when work starts/completes. Sessions hang indefinitely waiting for responses the user never sees. The `notifyEnabled` toggle exists in Settings but is completely unimplemented.

## Proposed Solution

Use `UNUserNotificationCenter` to schedule local notifications from `AppCoordinator.routeMessage()` when the app is not in the foreground. No server-side APNs infrastructure is needed — notifications are triggered directly from WebSocket messages received while the app is backgrounded.

### Limitation

Local notifications only work while the WebSocket connection is alive. iOS typically suspends apps ~30 seconds after backgrounding (unless the audio session is active for trigger word mode). For long-running tasks where the user backgrounds the app for minutes, notifications will stop once the app is suspended. This is acceptable for v1 — the audio background mode already keeps the connection alive when trigger word is enabled, and a future APNs implementation can address the gap.

## Technical Approach

### Architecture

```
WebSocket message arrives
  → AppCoordinator.routeMessage()
    → existing routing (AppState, PromptService, etc.)
    → NotificationService.scheduleIfNeeded(trigger, session)
      → guard: notifyEnabled && !isInForeground && isAuthorized
      → throttle check (per-session cooldown)
      → UNUserNotificationCenter.add(request)
```

New components:
- `NotificationService` — owns authorization, scheduling, throttling, tap handling
- `ScenePhase` tracking in `ClaudeRemoteApp` → `AppState.isInForeground`

### Notification Content Layout

| Field | Content |
|-------|---------|
| **Title** | Session name (e.g., "claude_remote") |
| **Subtitle** | Trigger type label (e.g., "Permission Required", "Work Started") |
| **Body** | Truncated relevant content (first 200 chars). For permissions: tool + command. For questions: question text. For status: status label. |
| **Thread ID** | `sessionId` — groups notifications per session |
| **Sound** | Default for permissions/questions. None for status changes. |
| **Category** | `permission`, `question`, `status`, `error` (for future actionable buttons) |

### Triggers

| Event | Subtitle | Body | Sound |
|-------|----------|------|-------|
| `permission_request` | "Permission Required" | "Bash: ls -la" (tool + command) | Default |
| `ask_user_question` | "Question" | First question text, truncated | Default |
| `session_status → processing` | "Work Started" | "Processing..." | None |
| `session_status → idle` | "Work Complete" | "Session idle" | Default |
| `session_status → waiting` | "Waiting for Input" | "Session waiting" | Default |
| `ServerMessage.error` (session-scoped) | "Error" | Error message, truncated | Default |
| Subagent `permission_request` | "Permission Required" | "[agent desc] — Bash: ls -la" | Default |

**Not triggers**: Transport-level WebSocket errors, auth failures, reconnection events, token usage updates, subagent start/stop/tool (too noisy).

### Throttling

Per-session cooldown: **5 seconds**. If a notification was sent for a session within the last 5 seconds, the new notification is dropped UNLESS it has higher priority.

Priority order (highest first):
1. `permission_request` / `ask_user_question` — always delivered, replaces pending lower-priority
2. `error` — delivered if no permission/question pending
3. `session_status` changes — lowest priority, suppressed during cooldown

### Notification Tap Handling

Tapping a notification opens the app and switches to the session that generated it. The `userInfo` payload carries `sessionId`. `NotificationService` implements `UNUserNotificationCenterDelegate.userNotificationCenter(_:didReceive:)` to extract the session ID and call `AppCoordinator.switchSession()`.

No scroll-to-message behavior in v1.

### Authorization Flow

1. User toggles `notifyEnabled` ON in Settings
2. `NotificationService.requestAuthorization()` calls `UNUserNotificationCenter.requestAuthorization(options: [.alert, .sound])`
3. If **granted**: toggle stays ON, `isAuthorized = true`
4. If **denied**: toggle resets to OFF, toast: "Enable notifications in iOS Settings"
5. On app launch: `NotificationService.checkAuthorizationStatus()` syncs `isAuthorized` with system state. If user revoked in iOS Settings, `notifyEnabled` resets to OFF.

### Foreground Suppression

Add `@Environment(\.scenePhase)` to `ClaudeRemoteApp`. On change, update `AppState.isInForeground`. `NotificationService` checks this before scheduling.

Additionally, implement `UNUserNotificationCenterDelegate.userNotificationCenter(_:willPresent:)` to suppress notification banners when the app is in the foreground (return empty `UNNotificationPresentationOptions`).

## Acceptance Criteria

- [ ] `NotificationService` created with protocol for testability
- [ ] `UNUserNotificationCenter` authorization requested on first toggle-ON
- [ ] Toggle resets to OFF if user denies or revokes notification permission
- [ ] Notifications fire for: permission_request, ask_user_question, status changes (processing/idle/waiting), session-scoped errors
- [ ] Notifications suppressed when app is in foreground
- [ ] Notification content: title = session name, subtitle = event type, body = relevant text (truncated 200 chars)
- [ ] Notifications grouped by session via `threadIdentifier`
- [ ] Per-session 5-second throttle with priority ordering
- [ ] Tapping notification navigates to the relevant session
- [ ] Subagent permissions include agent description in notification body
- [ ] Foreground notification banners suppressed via delegate
- [ ] `ScenePhase` tracking added to `ClaudeRemoteApp` → `AppState.isInForeground`
- [ ] Existing `notifyEnabled` toggle wired to actual authorization flow
- [ ] All new code has tests (protocol-based mocking for UNUserNotificationCenter)
- [ ] `swift build` clean, `swift test` passes

## Dependencies & Risks

### Dependencies
- No server changes required
- No new SPM dependencies (UNUserNotificationCenter is in UserNotifications framework, part of iOS SDK)
- Existing `notifyEnabled` setting, `SettingsStore`, and `SettingsView` toggle

### Risks
- **App suspension kills WebSocket**: Notifications only work while the app is backgrounded but not suspended (~30s without audio). Mitigated by: (a) documenting the limitation, (b) trigger word mode keeps connection alive, (c) future APNs implementation.
- **Notification flood**: Rapid status changes could spam. Mitigated by per-session throttle with priority.
- **App Store review**: No concerns with local notifications (no background audio abuse, no APNs).

## Files to Modify

| File | Change |
|------|--------|
| `NotificationService.swift` (new) | `UNUserNotificationCenter` wrapper: authorization, scheduling, throttling, tap handling, delegate |
| `AppCoordinator.swift` | Call `notificationService.scheduleIfNeeded()` from `routeMessage()` for each trigger |
| `AppState.swift` | Add `isInForeground: Bool` |
| `ClaudeRemoteApp.swift` | Add `@Environment(\.scenePhase)` tracking, propagate to `AppState` |
| `SettingsView.swift` | Wire toggle to `NotificationService.requestAuthorization()` |
| `SettingsStore.swift` | No changes (already persists `notifyEnabled`) |
| `PromptServiceTests.swift` | No changes (prompt logic unchanged) |
| `NotificationServiceTests.swift` (new) | Tests for authorization flow, scheduling logic, throttling, priority |
| `AppCoordinatorTests.swift` | Tests for notification scheduling on message routing |

## Future Considerations (Out of Scope)

- **Actionable notifications**: "Allow"/"Deny" buttons on permission notifications (v2)
- **Remote push via APNs**: Server-side push for when app is fully suspended (v2)
- **Per-trigger-type toggles**: Granular notification settings (v2)
- **Badge count management**: Show pending prompt count on app icon (v2)
- **Custom notification sounds**: Distinct sounds per trigger type (v2)

## References

- Existing toggle: `SettingsView.swift:139-144`, `AppState.swift:112`, `SettingsStore.swift:64-66`
- Message routing: `AppCoordinator.swift:148` (`routeMessage()`)
- Session model: `Session.swift` (name, id, status, cwd, branch)
- Learned: state recovery after backgrounding — `docs/solutions/integration-issues/claude-code-remote-monitoring.md`
- Learned: session switch race conditions — `docs/solutions/code-quality/phase-8-review-fixes-race-security-perf.md`
- Learned: NSLock for delegate callbacks — `docs/solutions/concurrency-issues/voice-io-phase4-review-fixes.md`
