---
title: "iOS Native App Conversion"
date: 2026-01-30
status: decided
---

# iOS Native App Conversion

## What We're Building

A full native iOS app (SwiftUI) that replaces the current Safari web client for Claude Remote. The server (Node.js + Express + WebSocket) stays unchanged. The native app connects to the same WebSocket server and reimplements all client features using native iOS APIs.

## Why Native (Not Hybrid)

**Primary drivers:**
1. **Always-on microphone** -- iOS suspends web processes on background/screen lock, killing the mic stream. Native apps with `UIBackgroundModes: audio` can keep the mic alive through screen lock and app switching. This is impossible from Safari.
2. **Reliability** -- Safari WebSocket connections drop on background, process suspension causes state loss, PWA mode breaks Speech Recognition entirely. Native `URLSessionWebSocketTask` handles all of this.

**Why not hybrid (Capacitor):**
- Still WKWebView under the hood -- keyboard quirks, scroll issues, and some Safari bugs persist
- Two codebases to maintain (web + native plugins)
- Only partially solves reliability (WebSocket still runs in WKWebView)

**Why fully native wins:**
- Solves both problems completely
- Single codebase going forward
- Access to full iOS platform: Siri Shortcuts, widgets, proper haptics, Keychain
- On-device `SFSpeechRecognizer` -- no Safari bugs, no Apple server dependency for STT
- Personal sideload distribution avoids App Store review concerns about always-on mic

## Key Decisions

1. **SwiftUI over UIKit** -- Modern declarative UI, less boilerplate, good enough for this app's complexity
2. **Server stays unchanged** -- Same WebSocket protocol, same JSONL parsing on server side. iOS app is a drop-in client replacement.
3. **Personal sideload via Xcode** -- No App Store review. Avoids rejection risk for always-on mic.
4. **On-device speech recognition** -- `SFSpeechRecognizer` with `requiresOnDeviceRecognition = true`. No network dependency for trigger word detection.
5. **Background audio mode** -- `UIBackgroundModes: audio` + `AVAudioSession.Category.playAndRecord` keeps mic alive through screen lock.

## What We Gain

- Always-on trigger word listening (survives screen lock)
- Reliable WebSocket (no Safari suspension)
- On-device speech recognition (faster, more reliable, private)
- Native TTS via AVFoundation (better voice quality)
- Siri Shortcuts (trigger commands via Siri)
- Home screen widgets (session status)
- Proper haptics (UIImpactFeedbackGenerator)
- Keychain for auth token storage
- Native keyboard avoidance and scroll behavior
- No WKWebView quirks

## What We Lose

- Cross-platform web access (unless web version is maintained separately)
- All existing JS code (full rewrite, ~3,200 lines of JS becomes ~3,500 lines of Swift)
- Prism.js syntax highlighting (need native solution -- AttributedString or embedded mini WebView)
- Markdown rendering (need swift-markdown or MarkdownUI library)
- Zero-install access (currently just a URL)

## Estimated Scope

| Component | Lines (est.) | Notes |
|-----------|-------------|-------|
| WebSocket + auth + reconnect | ~400 | URLSessionWebSocketTask, token auth, exponential backoff |
| Session management | ~300 | List, switch, status tracking |
| Message rendering | ~800 | Markdown, code blocks, tool cards, diff display |
| Voice I/O | ~400 | SFSpeechRecognizer + AVSpeechSynthesizer |
| Trigger word mode | ~300 | Background audio session, wake word detection |
| Prompt/permission UI | ~400 | Permission cards, multi-choice, freeform input |
| Settings + persistence | ~200 | UserDefaults, Keychain for token |
| UI chrome | ~600 | Header, input bar, session drawer, action sheet |
| Subagent + task tracking | ~300 | Badge indicator, sheet list, inline task progress |
| **Total** | **~3,500** | |

## Architecture

```
iOS App (SwiftUI)
  ├── Models/
  │   ├── Session.swift          -- Session data model
  │   ├── Message.swift          -- Message types (assistant, user, tool, etc.)
  │   └── AppState.swift         -- ObservableObject for global state
  ├── Services/
  │   ├── WebSocketService.swift -- Connection, auth, reconnect, message routing
  │   ├── SpeechService.swift    -- Recognition + synthesis + trigger word
  │   └── NotificationService.swift
  ├── Views/
  │   ├── AuthView.swift
  │   ├── SessionListView.swift
  │   ├── ChatView.swift         -- Main message list
  │   ├── MessageView.swift      -- Individual message rendering
  │   ├── PromptCardView.swift   -- Permission/question cards
  │   ├── InputBarView.swift     -- Text input + mic + send
  │   ├── SettingsView.swift
  │   └── Components/
  │       ├── CodeBlockView.swift
  │       ├── ToolCardView.swift
  │       └── TaskListView.swift
  └── App/
      ├── ClaudeRemoteApp.swift  -- @main entry point
      └── Info.plist             -- UIBackgroundModes: audio
```

## Resolved Questions

1. **Markdown rendering** -- MarkdownUI (SwiftUI-native, renders Claude output out of the box, customizable code block themes)
2. **Syntax highlighting** -- Highlightr (highlight.js wrapper, renders to NSAttributedString natively, pairs with MarkdownUI code block customization)
3. **Keep web version?** -- Yes, as a passive fallback. No active feature development. Same server serves both.
4. **Minimum iOS version** -- iOS 26 only. Single user, single device. Use latest SwiftUI APIs without compromise.

## Next Steps

Run `/workflows:plan` to create a detailed implementation plan with phased delivery.
