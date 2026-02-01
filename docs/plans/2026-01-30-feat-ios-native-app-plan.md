---
title: "iOS Native App (SwiftUI)"
type: feat
date: 2026-01-30
---

# iOS Native App -- SwiftUI Rewrite of Claude Remote

## Overview

Replace the Safari web client with a native iOS app (SwiftUI) that connects to the same Node.js + WebSocket server. The server stays unchanged. The native app reimplements all client features using iOS platform APIs, solving the two fundamental limitations of the web client: always-on microphone (background audio) and reliable WebSocket connections.

See [brainstorm](/docs/brainstorms/2026-01-30-ios-native-app-conversion-brainstorm.md) for decision rationale.

## Problem Statement

iOS Safari suspends web processes on background/screen lock, which:
1. Kills the microphone stream -- trigger word detection dies instantly
2. Drops WebSocket connections -- session output is lost until manual reconnect
3. Breaks Speech Recognition in PWA mode entirely

A native app with `UIBackgroundModes: audio` solves both problems completely.

## Technical Approach

### Target
- iOS 26 only (single user, single device)
- SwiftUI with `@Observable` macro (iOS 17+)
- Personal sideload via Xcode (no App Store)
- Server stays 100% unchanged

### Dependencies
| Library | Purpose | Integration |
|---------|---------|-------------|
| [MarkdownUI](https://github.com/gonzalezreal/swift-markdown-ui) | Render Claude's markdown output | SPM |
| [Highlightr](https://github.com/raspu/Highlightr) | Syntax highlighting for code blocks | SPM |

No other third-party dependencies. All other functionality uses Apple frameworks:
- `URLSessionWebSocketTask` -- WebSocket
- `SFSpeechRecognizer` -- Speech recognition
- `AVSpeechSynthesizer` -- Text-to-speech
- `AVAudioSession` -- Background audio
- `Security` framework -- Keychain for token storage

### Architecture

```
ClaudeRemote/
  ├── App/
  │   ├── ClaudeRemoteApp.swift       -- @main, app lifecycle, audio session setup
  │   └── Info.plist                   -- UIBackgroundModes: audio, NSAppTransportSecurity
  ├── Models/
  │   ├── AppState.swift               -- @Observable, single source of truth
  │   ├── Session.swift                -- Session model + status enum
  │   ├── Message.swift                -- Message types (assistant, user, tool, prompt, etc.)
  │   └── WebSocketMessage.swift       -- Codable types for WS protocol
  ├── Services/
  │   ├── WebSocketService.swift       -- Connection, auth, reconnect, message routing
  │   ├── SpeechService.swift          -- Recognition + synthesis + trigger word
  │   ├── KeychainService.swift        -- Token storage
  │   └── HapticsService.swift         -- UIImpactFeedbackGenerator wrappers
  ├── Views/
  │   ├── ContentView.swift            -- Root: auth gate + main navigation
  │   ├── AuthView.swift               -- Token entry + server URL
  │   ├── ChatView.swift               -- Main message list + input bar
  │   ├── SessionPickerView.swift      -- Session list (sheet or sidebar)
  │   ├── MessageView.swift            -- Single message bubble rendering
  │   ├── PromptCardView.swift         -- Permission/question/multi-choice cards
  │   ├── InputBarView.swift           -- Text field + mic + send button
  │   ├── SettingsView.swift           -- All settings (Form-based)
  │   └── Components/
  │       ├── CodeBlockView.swift      -- Syntax-highlighted code with copy button
  │       ├── ToolCardView.swift       -- Collapsible tool call display
  │       ├── DiffView.swift           -- Side-by-side or unified diff display
  │       ├── TaskProgressView.swift   -- Task list with status indicators
  │       └── SubagentBadgeView.swift  -- Active subagent indicator
  └── Utilities/
      ├── JSONLParser.swift            -- Parse server's JSONL messages
      └── Extensions.swift             -- String, Color, Date helpers
```

## WebSocket Protocol Reference

The iOS app must implement the same WebSocket protocol as the web client. The server sends JSON messages; the client sends JSON actions.

### Client → Server Actions

| Action | Fields | Purpose |
|--------|--------|---------|
| `auth` | `token` | Authenticate with server |
| `watch_session` | `sessionId` | Start receiving output for a session |
| `unwatch_session` | `sessionId` | Stop receiving output |
| `refresh_sessions` | -- | Request updated session list |
| `catch_up` | `sessionId` | Request recent history (after background return) |
| `inject` | `command`, `sessionId` | Send command to Claude |
| `escape` | `sessionId` | Send Ctrl+C to cancel |
| `mode_toggle` | `sessionId` | Send Shift+Tab to cycle modes |
| `update_settings` | `settings` | Sync client settings |
| `ping` | -- | Heartbeat (every 15s) |
| `get_state` | -- | Request client state dump |

### Server → Client Message Types

| Type | Key Fields | Purpose |
|------|-----------|---------|
| `auth_result` | `success`, `error?` | Auth response |
| `sessions` | `data[]` | Session list (id, name, status, tty, branch) |
| `watching` | `sessionId`, `session` | Confirmed watch |
| `history` | `sessionId`, `data[]` | Recent parsed messages |
| `assistant` | `content` | Claude's text response |
| `user` | `content` | User message echo |
| `tool` | `tool`, `input`, `language?` | Tool call (Read, Write, Bash, etc.) |
| `tool_result` | `content`, `language?` | Tool execution output |
| `status_update` | `status` | `processing` / `waiting` / `idle` |
| `session_status` | `sessionId`, `status`, `lastActive` | Session-level status |
| `permission_request` | `tool`, `command`, `isDestructive?` | Permission prompt |
| `ask_user_question` | `questions[]` | Structured multi-choice/freeform |
| `task_create` | `subject`, `description`, `activeForm?` | Task created |
| `task_update` | `taskId`, `status`, `subject?` | Task status change |
| `subagent_starting` | `description`, `type` | Subagent about to spawn |
| `subagent_start` | `agentId`, `sessionId` | Subagent running |
| `subagent_output` | `agentId`, `content` | Subagent streaming text |
| `subagent_tool` | `agentId`, `tool`, `input` | Subagent tool call |
| `subagent_tokens` | `agentId`, `usage` | Subagent token stats |
| `subagent_stop` | `agentId` | Subagent finished |
| `token_usage` | `usage` | Token usage for main session |
| `claude_output` | `line`, `sessionId` | Raw JSONL line (for debug) |
| `inject_result` | `success`, `error?` | Command send result |
| `escape_result` | `success`, `error?` | Escape result |
| `mode_toggle_result` | `success`, `error?` | Mode toggle result |
| `pong` | `timestamp` | Heartbeat response |
| `state` | `clientId`, `watchingSessions`, `settings` | Client state |
| `error` | `code`, `message`, `details` | Error (codes: RATE_LIMITED, UNAUTHORIZED, SESSION_NOT_FOUND, INJECT_FAILED) |

## Implementation Phases

### Phase 1: Foundation -- WebSocket + Auth + Session List

**Goal**: Connect to server, authenticate, display session list.

#### Files

##### `ClaudeRemote/App/ClaudeRemoteApp.swift`
```swift
@main
struct ClaudeRemoteApp: App {
    @State private var appState = AppState()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(appState)
        }
    }
}
```

##### `ClaudeRemote/Models/AppState.swift`
```swift
@Observable
final class AppState {
    var isAuthenticated = false
    var sessions: [Session] = []
    var currentSessionId: String?
    var messages: [Message] = []
    var sessionStatus: SessionStatus = .idle
    var isConnected = false
    var activeSubagents: [String: SubagentInfo] = [:]
    var tasks: [TaskItem] = []

    // Settings
    var ttsEnabled = false
    var triggerEnabled = false
    var speechRate: Float = 1.0
    var voiceIdentifier: String?

    // Services (not observed)
    @ObservationIgnored var webSocket: WebSocketService?
    @ObservationIgnored var speech: SpeechService?
}
```

##### `ClaudeRemote/Models/WebSocketMessage.swift`
```swift
// Codable enums for all server message types
enum ServerMessage: Decodable {
    case authResult(success: Bool, error: String?)
    case sessions(data: [Session])
    case watching(sessionId: String, session: Session)
    case history(sessionId: String, data: [Message])
    case assistant(content: String)
    case user(content: String)
    case tool(tool: String, input: ToolInput?, language: String?)
    case toolResult(content: String, language: String?)
    case statusUpdate(status: String)
    case sessionStatus(sessionId: String, status: String, lastActive: String?)
    case permissionRequest(tool: String, command: String?, isDestructive: Bool?)
    case askUserQuestion(questions: [Question])
    case taskCreate(subject: String, description: String?, activeForm: String?)
    case taskUpdate(taskId: String, status: String, subject: String?)
    case taskList(tasks: [TaskItem])
    case subagentStarting(description: String, type: String?)
    case subagentStart(agentId: String, sessionId: String?)
    case subagentOutput(agentId: String, content: String)
    case subagentTool(agentId: String, tool: String, input: String?)
    case subagentTokens(agentId: String, usage: TokenUsage?)
    case subagentStop(agentId: String)
    case tokenUsage(usage: TokenUsage)
    case claudeOutput(line: String, sessionId: String?)
    case injectResult(success: Bool, error: String?)
    case escapeResult(success: Bool, error: String?)
    case modeToggleResult(success: Bool, error: String?)
    case error(code: String, message: String)
    case pong(timestamp: Int)
    case state(clientId: String?, watchingSessions: [String]?, settings: [String: AnyCodable]?)
    case unknown(type: String, raw: [String: AnyCodable])  // Forward-compat: new types don't crash

    enum CodingKeys: String, CodingKey {
        case type
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let type = try container.decode(String.self, forKey: .type)
        // Switch on type, decode remaining fields from same container
        // Default case → .unknown(type: type, raw: ...)
    }
}
```

##### `ClaudeRemote/Services/WebSocketService.swift`
```swift
@MainActor
final class WebSocketService {
    private var task: URLSessionWebSocketTask?
    private var urlSession: URLSession
    private var serverURL: URL
    private var token: String
    private var reconnectAttempts = 0
    private let maxReconnectDelay: TimeInterval = 30
    private var pingTimer: Timer?
    private let pathMonitor = NWPathMonitor()  // Network availability

    func connect() { /* create task, send auth, start receive loop */ }
    func disconnect() { /* cancel task, stop timers */ }
    func send(_ action: ClientAction) { /* encode and send */ }
    private func receiveLoop() { /* recursive receive, decode, route to AppState */ }
    private func scheduleReconnect() { /* exponential backoff, skip if offline */ }
    private func startPingTimer() { /* 15s interval */ }
}
```

##### `ClaudeRemote/Services/KeychainService.swift`
```swift
enum KeychainService {
    static func save(token: String, for server: String) throws { /* SecItemAdd */ }
    static func load(for server: String) -> String? { /* SecItemCopyMatching */ }
    static func delete(for server: String) throws { /* SecItemDelete */ }
}
```

#### Acceptance Criteria

- [x] App launches, shows auth screen if no saved token
- [x] Token entered, saved to Keychain, WebSocket connects
- [x] Auth message sent, `auth_result` received and handled
- [x] `sessions` message populates session list
- [x] `refresh_sessions` action works (pull-to-refresh)
- [x] Session shows name, status, branch, last active time
- [x] Tapping session sends `watch_session`, receives `watching` + `history`
- [x] Connection status indicator in UI (connected/reconnecting)
- [x] Exponential backoff reconnection (300ms → 600ms → ... → 30s max)
- [x] Ping/pong heartbeat every 15 seconds
- [x] `pong` timeout (5s) triggers reconnect (not 3s -- too aggressive for cellular)
- [x] Reconnect restores watched session automatically
- [x] Handle `error` messages with appropriate UI feedback
- [x] Handle WebSocket close codes (4001 = unauthorized)

---

### Phase 2: Message Rendering + Chat View

**Goal**: Display Claude's output as a scrolling chat with markdown, code blocks, tool cards, and diffs.

#### Files

##### `ClaudeRemote/Views/ChatView.swift`
- ScrollView with LazyVStack for messages
- Auto-scroll to bottom on new messages (with user-scroll-back detection)
- Max 500 messages in memory (trim oldest)
- Pull-up to load more (from history)
- Empty state when no session selected

##### `ClaudeRemote/Views/MessageView.swift`
- Route by message type: assistant, user, tool, tool_result, status
- Assistant messages: MarkdownUI rendering
- User messages: plain text bubble
- Tool messages: collapsible ToolCardView
- Status messages: subtle inline indicator

##### `ClaudeRemote/Views/Components/CodeBlockView.swift`
- Extract code blocks from markdown
- Apply Highlightr syntax highlighting
- Copy button (UIPasteboard)
- Language label
- Line numbers (optional)
- Horizontal scroll for long lines

##### `ClaudeRemote/Views/Components/ToolCardView.swift`
- Collapsed: tool icon + name + summary (first line of input)
- Expanded: full input + output with syntax highlighting
- Tap to toggle
- Tool-specific icons (Read → doc, Write → pencil, Bash → terminal, etc.)

##### `ClaudeRemote/Views/Components/DiffView.swift`
- Parse Edit tool's old_string/new_string into diff
- Show context lines around changes
- Green/red line coloring
- Line numbers
- Truncate large diffs with "show more"

#### Acceptance Criteria

- [x] `history` messages render correctly on session load
- [x] Streaming `assistant` messages append in real-time
- [x] Markdown renders: headers, bold, italic, lists, links, inline code
- [x] Code blocks render with syntax highlighting (Swift, Python, JS, Ruby, Bash, JSON, etc.)
- [x] Tool cards show collapsed summary, expand on tap
- [x] Edit tool shows inline diff with +/- coloring
- [x] User messages appear as right-aligned bubbles
- [x] Status updates show as subtle indicators (processing spinner, waiting badge)
- [x] Auto-scroll to bottom on new messages
- [x] User can scroll up without being pulled back down
- [x] `claude_output` raw lines handled (debug mode)
- [x] Empty assistant messages (tool-only responses) are filtered out
- [x] Message deduplication for user messages (10s window)

---

### Phase 3: Command Input + Prompt Cards

**Goal**: Send commands to Claude and respond to permission/question prompts.

#### Files

##### `ClaudeRemote/Views/InputBarView.swift`
- TextField with dynamic height (auto-resize)
- Send button (disabled when empty or disconnected)
- Mic button (toggles voice input)
- Keyboard avoidance (native SwiftUI)
- Autocomplete for slash commands (/, /help, /clear, etc.)

##### `ClaudeRemote/Views/PromptCardView.swift`
- Permission prompt: Allow/Deny buttons, command preview, destructive styling
- Yes/No prompt: two buttons
- Multi-choice: numbered option buttons + "Other" freeform
- Freeform: text input field
- Multi-select support (checkboxes for multi-select questions)
- Queue system (if multiple prompts arrive, show one at a time)
- Slide-up animation from bottom
- Keyboard avoidance when prompt has text input
- Subagent prompt routing (send response with subagentId if applicable)

#### Acceptance Criteria

- [ ] Text input sends `inject` action with `sessionId`
- [ ] `inject_result` shows success/error toast
- [ ] Send button disabled during send, re-enabled after 300ms
- [ ] Duplicate send protection (same text within 10s)
- [ ] `permission_request` shows permission card with Allow/Deny
- [ ] Destructive permissions styled with warning color
- [ ] `ask_user_question` renders multi-choice options
- [ ] Multi-select questions show checkboxes
- [ ] "Other" option allows freeform text input
- [ ] Prompt queue: second prompt waits until first is dismissed
- [ ] Escape button sends `escape` action
- [ ] Mode toggle button sends `mode_toggle` action
- [ ] Keyboard dismissal on scroll
- [ ] Return key sends (with option for newline via Shift+Return)

---

### Phase 4: Voice I/O

**Goal**: Speech recognition for input, text-to-speech for output, prompt voice responses.

#### Files

##### `ClaudeRemote/Services/SpeechService.swift`
```swift
@MainActor @Observable
final class SpeechService {
    var isListening = false
    var transcript = ""
    var isSpeaking = false

    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))!
    private let synthesizer = AVSpeechSynthesizer()
    private let audioEngine = AVAudioEngine()
    private var recognitionTask: SFSpeechRecognitionTask?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?

    func startListening() { /* request auth, configure audio, start recognition */ }
    func stopListening() { /* stop recognition task + audio engine */ }
    func speak(_ text: String, rate: Float, voiceId: String?) { /* AVSpeechUtterance */ }
    func stopSpeaking() { /* synthesizer.stopSpeaking */ }
    func speakThenListen(_ text: String) { /* speak, then start listening on completion */ }
}
```

#### Key Implementation Details

**SFSpeechRecognizer setup:**
```swift
recognizer.supportsOnDeviceRecognition // check first
request.requiresOnDeviceRecognition = true
request.shouldReportPartialResults = true
// 1-minute recognition windows (Apple limit)
// Restart recognition task every 55 seconds to avoid timeout
```

**AVAudioSession configuration:**
```swift
let session = AVAudioSession.sharedInstance()
try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth])
try session.setActive(true)
```

**Voice prompt response flow:**
1. Claude sends `permission_request` or `ask_user_question`
2. If TTS enabled, speak the question text
3. After TTS ends, start listening for voice response
4. Match response: "yes"/"allow" → approve, "no"/"deny" → reject, number → select option
5. Send response via WebSocket

#### Acceptance Criteria

- [ ] Mic button toggles speech recognition on/off
- [ ] Interim results show in text field as user speaks
- [ ] Final result populates text field (user can edit before sending)
- [ ] TTS reads assistant messages when enabled
- [ ] TTS reads tool summaries when "Speak Tools" enabled
- [ ] Voice selection from available system voices
- [ ] Speech rate adjustable (0.5x - 2x)
- [ ] `speakThenListen` works for prompt responses
- [ ] Voice responses to permission cards ("yes", "no", "allow", "deny")
- [ ] Voice responses to multi-choice ("one", "two", "three", etc.)
- [ ] Microphone permission request handled gracefully
- [ ] Speech recognition permission request handled gracefully
- [ ] Recognition restarts on timeout (55s window)
- [ ] Audio session interruption handling (phone call, Siri, etc.)

---

### Phase 5: Trigger Word Mode (Background Audio)

**Goal**: Always-on "Titus" wake word detection that survives screen lock.

#### Key Implementation Details

**Info.plist:**
```xml
<key>UIBackgroundModes</key>
<array>
    <string>audio</string>
</array>
<key>NSAppTransportSecurity</key>
<dict>
    <key>NSAllowsLocalNetworking</key>
    <true/>
</dict>
<key>NSSpeechRecognitionUsageDescription</key>
<string>Speech recognition is used for voice commands and trigger word detection.</string>
<key>NSMicrophoneUsageDescription</key>
<string>The microphone is used for voice input and always-on trigger word listening.</string>
```

**Audio session for background:**
```swift
let session = AVAudioSession.sharedInstance()
try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth, .mixWithOthers])
try session.setActive(true, options: .notifyOthersOnDeactivation)
```

**Trigger word state machine:**
```
LISTENING ──(trigger detected)──→ CAPTURING ──(silence/send)──→ COOLDOWN ──(300ms)──→ LISTENING
    │                                  │
    └──(user disables)──→ IDLE         └──(cancel/stop)──→ LISTENING
```

**SFSpeechRecognizer for trigger detection:**
- On-device only (`requiresOnDeviceRecognition = true`)
- 55-second recognition windows with seamless restart
- Check each partial result for trigger variants
- Trigger variants: `["titus", "tightest", "tidus", "tidas", "titis", "tight us", "title"]`
- Case-insensitive prefix match

**Command capture after trigger:**
- Extract text after trigger word in same utterance
- If text exists, start 3-second silence timer
- If no text, wait for next utterance (new recognition window)
- Accumulate text from partial results
- 3-second silence → auto-send command
- "cancel"/"stop" → abort capture, return to LISTENING

**Background survival:**
- `UIBackgroundModes: audio` keeps audio engine alive through screen lock
- `AVAudioSession.interruptionNotification` handles interruptions
- Resume recognition after interruption ends
- Keep-alive: audio engine must have an active input tap

**Priority arbitration (single audio engine):**
1. Prompt voice response (highest) -- pauses trigger listening
2. Manual mic button -- pauses trigger listening
3. TTS playback -- pauses trigger listening
4. Trigger word listening (lowest) -- yields to all above, resumes after

#### Acceptance Criteria

- [x] Toggle trigger mode in settings
- [x] Trigger mode persisted across app launches (UserDefaults)
- [x] On enable: starts listening, visual indicator in UI
- [x] "Titus" detected → haptic feedback + visual state change
- [x] Text after trigger word captured as command
- [x] 3-second silence auto-sends command
- [x] "Cancel"/"Stop" aborts capture, returns to listening
- [x] Trigger mode survives screen lock (background audio)
- [x] Trigger mode survives app switching
- [x] Audio interruption (phone call) pauses and resumes
- [x] Manual mic tap pauses trigger, resumes after
- [x] TTS pauses trigger, resumes after
- [x] Prompt response pauses trigger, resumes after
- [x] No false triggers from TTS playback (mute mic during TTS)
- [x] Visual indicators: LISTENING (teal pulse), CAPTURING (red pulse), IDLE (no indicator)
- [x] Empty command after trigger → discard, return to LISTENING
- [x] No session selected → error toast, return to LISTENING

---

### Phase 6: Subagent + Task Tracking

**Goal**: Display active subagents and task progress.

#### Files

##### `ClaudeRemote/Views/Components/SubagentBadgeView.swift`
- Badge on header showing count of active subagents
- Tap to show sheet with subagent list
- Each subagent: description, status, duration, latest output preview

##### `ClaudeRemote/Views/Components/TaskProgressView.swift`
- Inline task list in chat view
- Each task: subject, status (pending/in_progress/completed), activeForm spinner text
- Status icons: pending (circle), in_progress (spinner), completed (checkmark)
- Collapsible description

#### Acceptance Criteria

- [x] `subagent_starting` shows "launching" indicator
- [x] `subagent_start` adds to active list with badge count
- [x] `subagent_output` updates subagent's latest output
- [x] `subagent_stop` removes from active list
- [x] Subagent permission prompts route correctly (with agentId)
- [x] `task_create` adds task to list
- [x] `task_update` updates task status
- [x] Completed tasks show checkmark
- [x] In-progress tasks show spinner with activeForm text

---

### Phase 7: Settings + Polish

**Goal**: Complete settings UI, persistent configuration, final polish.

#### Files

##### `ClaudeRemote/Views/SettingsView.swift`
```swift
struct SettingsView: View {
    @Environment(AppState.self) var state

    var body: some View {
        Form {
            Section("Connection") {
                // Server URL
                // Auth token (masked)
                // Connection status
                // Disconnect button
            }
            Section("Voice Output") {
                Toggle("Text-to-Speech", isOn: $state.ttsEnabled)
                Toggle("Speak Tool Results", isOn: $state.speakTools)
                Picker("Voice", selection: $state.voiceIdentifier) { /* system voices */ }
                Slider("Speech Rate", value: $state.speechRate, in: 0.5...2.0)
            }
            Section("Voice Input") {
                Toggle("Trigger Word (\"Titus\")", isOn: $state.triggerEnabled)
            }
            Section("Notifications") {
                Toggle("Push Notifications", isOn: $state.notifyEnabled)
            }
            Section("Developer") {
                Toggle("Debug Mode", isOn: $state.debugMode)
                // Token usage display
                // WebSocket state
            }
            Section("About") {
                // Version
                // Server info
            }
        }
    }
}
```

#### Acceptance Criteria

- [x] All settings persist via UserDefaults
- [x] Auth token stored in Keychain (not UserDefaults)
- [x] Settings sync to server via `update_settings`
- [x] Voice picker shows all available system voices
- [x] Debug mode shows raw JSONL in chat
- [x] App icon and launch screen (N/A — SPM library, asset catalogs belong in consuming Xcode project)
- [x] Haptic feedback on key actions (send, receive prompt, trigger detected)
- [x] Toast notifications for transient feedback
- [x] Error states: no sessions, disconnected, auth failed
- [x] Pull-to-refresh on session list
- [x] Swipe gestures for session switching (if applicable)

## Technical Considerations

### Background Audio Lifecycle

The most complex aspect of this app. Key scenarios:

1. **Screen lock while trigger listening**: Audio engine keeps running via `UIBackgroundModes: audio`. Recognition windows continue their 55-second restart cycle.

2. **Phone call interruption**: `AVAudioSession.interruptionNotification` fires with `.began`. Stop recognition. When `.ended` fires with `shouldResume`, restart recognition and audio engine.

3. **Siri activation**: Same interruption pattern as phone calls.

4. **Another app takes audio**: If the interruption doesn't end (e.g., music app), trigger mode effectively pauses. Resume when user returns to app or interruption ends.

5. **App termination**: If iOS terminates the app in background (low memory), trigger mode is lost. On next launch, if trigger was enabled, prompt user to re-enable (don't auto-start to avoid unexpected mic activation).

### WebSocket Reconnection

The WebSocket will die when the app is backgrounded -- accept this. The audio session stays alive for trigger word detection via `UIBackgroundModes: audio`, but `URLSessionWebSocketTask` does not survive background suspension.

1. On disconnect: exponential backoff (300ms, 600ms, 1.2s, ... 30s max)
2. On reconnect: send `auth`, then `watch_session` for last watched session
3. On app foregrounding after background: check connection, reconnect if needed, send `catch_up`

### Memory Management

- Cap messages at 500 in memory (same as web client)
- Lazy rendering with `LazyVStack` -- only messages in viewport are rendered
- Code blocks: apply Highlightr only when scrolled into view (not on parse)
- Large tool outputs: truncate in memory, show "Load full output" option

### Thread Safety

- `AppState` mutations must happen on `@MainActor`
- `WebSocketService` and `SpeechService` are also `@MainActor` -- simplifies dispatch since they only mutate AppState
- WebSocket receive loop: use `Task { @MainActor in ... }` for the recursive receive call
- If performance profiling shows main thread pressure, move services off `@MainActor` later

## Critical Patterns to Port from Web Client

These patterns exist in the web client and are essential for correct behavior. Omitting any of them will cause visible bugs.

### 1. Permission Card Delay-and-Suppress (500ms)

The web client waits 500ms before showing a permission card. If a `tool_result` arrives within that window, the card is suppressed -- the tool was auto-approved. Without this, every auto-approved tool call flashes a permission card.

```
permissionRequest arrives → start 500ms timer
  if tool_result arrives before timer → suppress card
  if timer fires → show card
```

**Web client**: `public/js/prompts.js` -- `PERMISSION_CARD_DELAY_MS = 500`

### 2. Session Switch State Machine

Prevents race conditions during session switching. Messages from the old session must not appear in the new session's chat.

```swift
enum SessionState { case idle, switching, active }
// IDLE → (user taps session) → SWITCHING → (watching confirmed) → ACTIVE
// Queue prompt messages that arrive during SWITCHING
```

**Web client**: `public/js/state.js:22-25` -- `SESSION_STATE` enum

### 3. Message Deduplication (10s window)

When the user sends a command, the app appends it locally AND the server echoes it as a `user` message. Without dedup, every command appears twice.

```swift
// Track sent messages: normalized content → timestamp
// When server sends `user` message, check if it matches a recent send
// If match within 10s, suppress the echo
```

**Web client**: `public/js/state.js:79-106` -- `recentUserMessages` Map

### 4. Prompt Staleness Detection

If 2+ new messages arrive after a prompt card was shown, mark it as "stale" -- Claude may have moved on.

**Web client**: `public/js/prompts.js` -- `checkPromptStaleness()`

### 5. Auto-Scroll with User Override

Auto-scroll to bottom on new messages ONLY if user is within ~50pt of the bottom. If user scrolled up to read history, show a "new messages" indicator instead of yanking them down.

### 6. Subagent Permission Routing

Subagent permission cards must include the `subagentId` so the response routes to the correct subagent, not the main session. The delay-and-suppress pattern applies per-subagent.

**Web client**: `public/js/state.js:119-120` -- `pendingSubagentPermissions` Map

### 7. Multi-Select Inject Pattern

Multi-select prompt responses use sequential `inject` commands with 1-second delays between each selection, then an empty inject to submit. Fragile but required by the server protocol.

**Web client**: `public/js/prompts.js` -- multi-select response handling

### 8. `tool_result` Dismisses Already-Shown Permission Cards

Not just suppression of pending cards -- if a permission card is *already visible*, a `tool_result` arrival must dismiss it immediately. Also flushes all permission-type entries from the prompt queue.

**Web client**: `public/js/connection.js:366-382`

### 9. `session_status` Auto-Dismisses Stale Prompts

When `session_status` arrives with status `processing` and a prompt card is visible, dismiss it -- the user (or another client) already responded.

**Web client**: `public/js/connection.js:422-428`

### 10. History Prompt Recovery

On session load, if the last item in history is an unanswered prompt, re-show the prompt card. Without this, switching sessions and coming back loses the pending permission card.

**Web client**: `public/js/sessions.js:361-409`

### 11. Voice Prompt Number Mapping

Voice responses to permission cards must send `1`/`3` (the numbered option), not `y`/`n` or `yes`/`no`. Permission prompts present numbered options (1=Allow Once, 2=Always Allow, 3=Deny). Multi-choice questions also use number selection.

**Web client**: `public/js/ui.js:825-860` -- `handleVoicePromptResponse()`

### 12. Reconnect Sends `watch_session` Not `catch_up`

After reconnect + auth, the web client re-sends `watch_session` for the last watched session. `catch_up` does not re-establish the file watcher on the server -- it only sends history. The server's `watch_session` handler already calls `sendRecentHistory()`, so `watch_session` alone is sufficient.

**Web client**: `public/js/connection.js:266-268`

## iOS-Specific Design Decisions

### Scene Phase Handling

```swift
// In ClaudeRemoteApp.swift
.onChange(of: scenePhase) { oldPhase, newPhase in
    switch newPhase {
    case .active:
        // Reconnect WebSocket if needed
        // Send catch_up for watched session
        // Resume trigger word listening
    case .inactive:
        // No action (transient state)
    case .background:
        // WebSocket will die (accept this -- use catch_up on return)
        // Audio session stays alive for trigger word (UIBackgroundModes: audio)
        // TTS stops
    }
}
```

### Keychain Accessibility

Use `.afterFirstUnlockThisDeviceOnly` -- the token must be accessible when the device is locked (for background reconnection) but should not sync to other devices.

### Transport Security

The server runs plain HTTP (`http.createServer`). The auth token travels in plaintext. Mitigations:
- `NSAppTransportSecurity` → `NSAllowsLocalNetworking = true` in Info.plist (required for local HTTP)
- Local network only (same WiFi)
- Or require SSH tunnel / Tailscale for remote access
- Document this limitation clearly in the app's auth screen

### WebSocket Background Behavior

Accept that the WebSocket dies when backgrounded. The audio session stays alive for trigger word detection. On foreground return, reconnect and send `catch_up`. This matches the web client's behavior and avoids the complexity of `URLSessionConfiguration.background` (which doesn't reliably support WebSocket).

### Thread Safety

`AppState`, `WebSocketService`, and `SpeechService` are all `@MainActor`. This simplifies the code since all state mutations happen on the main thread:

```swift
@MainActor @Observable
final class AppState { ... }

@MainActor
final class WebSocketService { ... }

@MainActor @Observable
final class SpeechService { ... }
```

If profiling shows main thread pressure, services can be moved off `@MainActor` later with explicit dispatch.

## Dependencies & Risks

| Risk | Mitigation |
|------|------------|
| SFSpeechRecognizer 1-minute limit | Restart recognition every 55 seconds, seamless transition |
| iOS 18 speech recognition truncation bug | Test on iOS 26, use newer SpeechAnalyzer API if available |
| Background audio rejection by iOS | Keep audio engine input tap active; play silent audio if needed |
| MarkdownUI rendering performance | Limit re-renders with `.id()` on messages; consider caching |
| Highlightr cold start latency | Pre-load Highlightr instance on app launch |
| Keychain access on first launch | Handle `errSecItemNotFound` gracefully |
| WebSocket dies in background | Accept and use `catch_up` on foreground return |
| Timer throttling in Low Power Mode | Use appropriate `tolerance` values on timers |
| Audio session interruption (phone call) | Handle `interruptionNotification`, restart on `.ended` |

## Success Metrics

- Trigger word detection works through screen lock for 30+ minutes
- WebSocket stays connected through screen lock
- All web client features are functional in native app
- Voice command round-trip (trigger → send → response) under 2 seconds
- App launches and connects in under 3 seconds
- Permission cards correctly suppress for auto-approved tools
- No duplicate messages in chat

## References

### Internal
- Server WebSocket protocol: `server.js:1140-1340` (message handling)
- Server session discovery: `server.js:206-360` (discoverSessions)
- Server JSONL parsing: `server.js:400-970` (processLine)
- Web client state: `public/js/state.js` (all client state)
- Web client sessions: `public/js/sessions.js` (session management)
- Web client voice: `public/js/init.js` (speech recognition)
- Web client UI: `public/js/ui.js` (voice functions, trigger mode)
- Web client prompts: `public/js/prompts.js` (prompt card logic)
- Web client rendering: `public/index.html:2400-4466` (message rendering, tool cards, diffs)

### External
- [URLSessionWebSocketTask](https://developer.apple.com/documentation/foundation/urlsessionwebsockettask)
- [SFSpeechRecognizer](https://developer.apple.com/documentation/speech/sfspeechrecognizer)
- [AVAudioSession](https://developer.apple.com/documentation/avfaudio/avaudiosession)
- [AVSpeechSynthesizer](https://developer.apple.com/documentation/avfaudio/avspeechsynthesizer)
- [MarkdownUI](https://github.com/gonzalezreal/swift-markdown-ui)
- [Highlightr](https://github.com/raspu/Highlightr)
- [@Observable macro](https://developer.apple.com/documentation/observation)
