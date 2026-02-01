# Increase iOS Test Coverage

## Current State

**299 tests** across **14 test files** covering **14 of 31 source files** (45% file coverage).

### Coverage by Category

| Category | Source Files | Tested Files | Coverage |
|----------|-------------|-------------|----------|
| Models | 4 | 4 | 100% |
| Services | 5 | 5 | 100% |
| Utilities | 6 | 3 | 50% |
| Views | 7 | 0 | 0% |
| Views/Components | 7 | 2 | 29% |
| App | 1 | 0 | 0% |

### Test Counts Per File

| Test File | Tests |
|-----------|-------|
| WebSocketMessageTests | 59 |
| AppCoordinatorTests | 46 |
| SpeechServiceTests | 30 (includes VoicePromptMatcher) |
| PromptServiceTests | 25 |
| TriggerWordDetectorTests | 25 |
| ExtensionsTests | 23 |
| MessageTests | 16 |
| DiffViewTests | 14 |
| SettingsStoreTests | 12 |
| KeychainServiceTests | 10 |
| WebSocketServiceTests | 8 |
| AppStateTests | 17 |
| ToastViewTests | 7 |
| SessionTests | 7 |

### 17 Untested Source Files

1. Views: AuthView, ChatView, ContentView, InputBarView, MessageView, SessionPickerView, SettingsView
2. View Components: CodeBlockView, PromptCardView, SessionStatusBadge, SubagentBadgeView, TaskProgressView, ToolCardView
3. Utilities: HapticService, SyntaxHighlighting
4. App: ClaudeRemoteApp

### Key Coverage Gaps in Existing Test Files

| File | Missing Coverage |
|------|-----------------|
| AppStateTests (17) | `mergeOrAppendToolResult` entirely untested, dedup expiration, "(no content)" filter, context window properties |
| WebSocketServiceTests (8) | `webSocketURL(from:)` untested, connect/disconnect/send untested, ping/pong untested |
| AppCoordinatorTests (46) | Token usage context tracking, toast at 90% threshold |

---

## Plan

### Tier 1: Quick Wins (Pure Logic, No Infrastructure Needed)

These are pure functions or simple state mutations that can be tested immediately with the existing test patterns.

#### 1.1 AppState — `mergeOrAppendToolResult` Tests

**File:** `AppStateTests.swift`
**Source:** `AppState.swift:143-165`

Tests to add:
- `mergeOrAppendToolResult` merges result into existing tool_use message by toolUseId
- `mergeOrAppendToolResult` appends as new message when no matching toolUseId exists
- `mergeOrAppendToolResult` appends when message has no toolUseId
- `mergeOrAppendToolResult` matches against permissionRequest type (not just tool)
- `mergeOrAppendToolResult` merges into the _last_ matching message (not first)

#### 1.2 AppState — Context Window Properties

**File:** `AppStateTests.swift`

Tests to add:
- `contextPercentage` returns 0 when `contextTokensUsed` is 0
- `contextPercentage` returns correct ratio (e.g., 100000/200000 = 0.5)
- `contextPercentage` caps at 1.0 when exceeding `defaultContextWindowSize`
- `beginSessionSwitch` resets `contextTokensUsed` to 0

#### 1.3 AppState — Dedup and Filtering

**File:** `AppStateTests.swift`

Tests to add:
- Duplicate user messages within dedup window are dropped
- `appendMessage` filters "(no content)" messages
- Messages after dedup window expires are not dropped

#### 1.4 WebSocketService — `webSocketURL(from:)` Tests

**File:** `WebSocketServiceTests.swift`
**Source:** `WebSocketService.swift:168-183`

Static pure function — trivially testable:
- `http://` converts to `ws://` with `/ws` path
- `https://` converts to `wss://` with `/ws` path
- Preserves host and port
- Returns nil for malformed URLs
- Handles trailing slash in path

#### 1.5 AppCoordinator — Context Token Tracking

**File:** `AppCoordinatorTests.swift`

Tests to add:
- `.tokenUsage` with sessionId matching current session updates `contextTokensUsed`
- `.tokenUsage` crossing 90% threshold fires warning toast
- `.tokenUsage` already above 90% does not re-fire toast

**Estimated: ~20 new tests**

---

### Tier 2: View Logic Extraction (Extract → Test)

These views contain testable business logic mixed into SwiftUI bodies. Extract the logic into standalone functions/computed properties, then test.

#### 2.1 ToolCardView — Tool Display Logic

**Source:** `ToolCardView.swift`
**New test file:** `ToolCardViewTests.swift`

Extractable logic:
- `toolIcon` mapping (Bash → terminal, Read → doc.text, etc.)
- `toolSummary` generation (Bash shows command, Read shows file path, etc.)
- `formatToolInput` formatting (different logic per tool type)
- `borderColor` based on message status (active=blue, error=red, etc.)

Approach: These are currently `private` computed properties on the view. Make them `static` functions or a small helper that takes a `Message` and returns the display value. Test the helper.

**~12 new tests**

#### 2.2 InputBarView — Send Logic

**Source:** `InputBarView.swift`
**New test file:** `InputBarViewTests.swift`

Extractable logic:
- `canSend` computed property (non-empty text + session watching + session not idle)
- Slash command suggestion filtering (prefix matching on typed text)
- Voice input toggle state

**~6 new tests**

#### 2.3 AuthView — URL Validation

**Source:** `AuthView.swift`
**New test file:** `AuthViewTests.swift`

Extractable logic:
- `isInsecureRemote` detection (http:// on non-localhost/127.0.0.1)
- URL format validation before connect
- Stored server URL persistence

**~5 new tests**

#### 2.4 SessionStatusBadge — Status Display

**Source:** `SessionStatusBadge.swift`

Extractable logic:
- Color mapping from session status string → Color
- Icon mapping from session status string → SF Symbol name

**~4 new tests**

**Estimated: ~27 new tests**

---

### Tier 3: Infrastructure Tests (Requires Mocking/Protocols)

These require more setup but cover critical paths.

#### 3.1 WebSocketService — Connection Lifecycle

**File:** `WebSocketServiceTests.swift`

Requires: URLSession mock or protocol abstraction for `URLSessionWebSocketTask`

Tests to add:
- `connect()` transitions state from disconnected → connecting → connected
- `disconnect()` cleans up task and transitions to disconnected
- `send()` serializes ClientAction and sends via task
- Received data is decoded and forwarded to delegate
- Invalid JSON received does not crash (resilient parsing)

**~8 new tests**

#### 3.2 SyntaxHighlighting — Language Detection and Tokenization

**Source:** `SyntaxHighlighting.swift`

Has `nonisolated(unsafe)` static cache — needs care with concurrency. Test the pure logic:
- Language keyword detection for Swift, JavaScript, Python, etc.
- Comment and string literal highlighting
- Unknown language fallback behavior

**~6 new tests**

**Estimated: ~14 new tests**

---

### Skip (Not Worth Testing)

| File | Reason |
|------|--------|
| HapticService | Thin wrapper around `UIImpactFeedbackGenerator` — no logic |
| ClaudeRemoteApp | App entry point with `@main` — no testable logic |
| ChatView | Pure layout composition — no business logic |
| ContentView | Orchestration view — logic is in AppState/AppCoordinator |
| MessageView | Rendering only — logic is in Message model (already tested) |
| SessionPickerView | Rendering only — data from AppState (already tested) |
| SettingsView | Rendering only — data from SettingsStore (already tested) |
| CodeBlockView | Rendering only — copy-to-clipboard is UIKit passthrough |
| PromptCardView | Rendering only |
| SubagentBadgeView | Rendering only |
| TaskProgressView | Rendering only |

---

## Summary

| Tier | New Tests | Files Modified | Files Created |
|------|-----------|---------------|---------------|
| Tier 1: Quick Wins | ~20 | 3 (existing test files) | 0 |
| Tier 2: Logic Extraction | ~27 | 4 (source) + 4 (tests) | 4 new test files |
| Tier 3: Infrastructure | ~14 | 2 (source + tests) | 1 new test file |
| **Total** | **~61** | | |

**Projected total: ~360 tests** (up from 299, a 20% increase).

## Execution Order

1. Tier 1 first — zero risk, no source changes, immediate coverage gain
2. Tier 2.1 (ToolCardView) — highest logic density among views
3. Tier 2.2-2.4 (remaining view logic) — parallel-safe, one file each
4. Tier 3 if time permits — deferred since it needs protocol abstractions

## Verification

After each tier:
1. `swift build` passes
2. `swift test` passes with increased test count
3. No source behavior changes (extract-only refactors in Tier 2)
