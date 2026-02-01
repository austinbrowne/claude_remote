---
title: "Live Context Percentage Tracker"
type: feat
date: 2026-02-01
---

# Live Context Percentage Tracker

## Overview

Show the session's context window usage as an always-visible, compact indicator in the chat view — so the user knows at a glance how close they are to needing `/compact`.

## Problem Statement

The existing `contextBar` only appears at 50% usage and sits above the chat view as a separate strip. By the time it's visible, the user is already halfway through the context window. There's no persistent, ambient signal showing context health from the start of a session.

## Proposed Solution

Replace the current conditional context bar with a compact, always-visible context ring in the chat header area. The ring is a small circular progress indicator (like Apple Watch activity rings) that sits in the navigation bar and provides ambient awareness without demanding attention.

### Design: Circular Progress Ring

A 20pt diameter circular ring in the navigation toolbar, styled like iOS system gauges:

- **Ring**: Thin (2pt stroke) circular progress indicator showing `contextPercentage`
- **Center text**: Percentage as compact label (`45%`) only when tapped/hovered, otherwise just the ring
- **Color**: Follows existing convention — green (<70%), orange (70-90%), red (>90%)
- **Position**: Leading edge of the navigation bar, beside the session name or in the toolbar
- **Always visible**: Shows from 0% onward (no threshold gate)
- **Animation**: Smooth progress animation on token updates (`withAnimation(.easeInOut)`)

### Why a Ring

- Minimal footprint — doesn't compete with chat content
- Universally understood (battery %, storage, Apple Watch rings)
- Color alone communicates urgency at a glance
- Tappable for detail without cluttering the default view

### Detail Popover (on tap)

Tapping the ring shows a compact popover with:
- "Context: 45% used"
- "~90k / 200k tokens"
- Suggestion text at >80%: "Consider /compact to free space"

### Flow

```
Session starts
  -> Ring shows at 0%, gray/green, thin stroke
  -> Token usage messages arrive
  -> Ring animates to new percentage
  -> Color shifts: green → orange → red as usage grows

User taps ring
  -> Popover shows token count + percentage + tip

90% threshold crossed
  -> Ring turns red
  -> Existing toast fires (unchanged): "Context nearly full — consider /compact"
```

## Acceptance Criteria

- [ ] Context ring visible in chat toolbar from session start (0%)
- [ ] Ring animates smoothly on token usage updates
- [ ] Color follows green/orange/red thresholds (existing convention)
- [ ] Tap shows detail popover with token count and percentage
- [ ] Popover shows "/compact" suggestion at >80%
- [ ] Ring resets to 0% on session switch (existing `beginSessionSwitch` handles this)
- [ ] Existing 90% toast behavior unchanged
- [ ] No ring shown when no session is active

## Technical Approach

### Files to modify

| File | Change |
|------|--------|
| `ContentView.swift` | Remove existing `contextBar`, add `ContextRingView` to toolbar |
| New: `ContextRingView.swift` | Circular progress ring + tap popover |
| `AppState.swift` | No changes needed — `contextPercentage` already computed |
| `AppCoordinator.swift` | No changes needed — token routing already works |

### ContextRingView.swift (new)

```swift
struct ContextRingView: View {
    @Environment(AppState.self) private var state
    @State private var showDetail = false

    private var pct: Double { state.contextPercentage }

    private var ringColor: Color {
        switch pct {
        case ..<0.7: .green
        case 0.7..<0.9: .orange
        default: .red
        }
    }

    var body: some View {
        ZStack {
            // Background track
            Circle()
                .stroke(Color.secondary.opacity(0.2), lineWidth: 2.5)
            // Progress
            Circle()
                .trim(from: 0, to: pct)
                .stroke(ringColor, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .animation(.easeInOut(duration: 0.4), value: pct)
        }
        .frame(width: 22, height: 22)
        .onTapGesture { showDetail.toggle() }
        .popover(isPresented: $showDetail) {
            ContextDetailView(pct: pct, tokens: state.contextTokensUsed)
        }
    }
}
```

### ContentView.swift

Remove the existing `contextBar` view and its `contextBarColor` helper. Add `ContextRingView` to the toolbar:

```swift
.toolbar {
    ToolbarItem(placement: .topBarLeading) {
        if state.currentSessionId != nil {
            ContextRingView()
        }
    }
}
```

### Edge Cases

- **No session**: Ring hidden (guard on `currentSessionId`)
- **Zero tokens**: Ring shows empty track (0% progress, gray)
- **Rapid updates**: Animation coalesces naturally via SwiftUI's animation system
- **Session switch**: `contextTokensUsed` resets to 0, ring animates back to empty

## What This Does NOT Do

- No persistent token count display (only in popover on tap)
- No changes to token data flow (server/WebSocket/coordinator all stay the same)
- No new data requirements — uses existing `contextPercentage` and `contextTokensUsed`
- No changes to the 90% toast behavior

## References

- `AppState.swift:99-106` — `contextTokensUsed`, `contextPercentage`, `defaultContextWindowSize`
- `AppCoordinator.swift:333-343` — token usage handler + 90% toast
- `ContentView.swift:289-325` — existing `contextBar` (to be removed)
- `AppState.swift:218-231` — `beginSessionSwitch` resets tokens
