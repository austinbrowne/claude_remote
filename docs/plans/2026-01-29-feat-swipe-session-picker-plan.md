---
title: "feat: Swipe-to-open session picker for mobile"
type: feat
date: 2026-01-29
---

# Swipe-to-Open Session Picker for Mobile

## Overview

Add a slide-out session picker drawer that opens via a left-to-right swipe gesture on mobile browsers. On mobile, this replaces the top `<select>` dropdown — the header selector is hidden and the swipe drawer becomes the primary way to switch sessions. Desktop browsers are unaffected.

## Problem Statement

The current session selector is a native `<select>` dropdown in the header. On mobile, native selects are clunky — they launch the OS picker wheel, which feels disconnected from the app. A swipe-to-reveal drawer matches the mental model of iOS/Android apps (e.g., Slack, Discord, Mail) where swiping from the left edge opens a navigation menu.

## Proposed Solution

### 1. Mobile Detection

Add a simple `isMobile()` helper using `matchMedia` for pointer coarseness (more reliable than user-agent sniffing):

```javascript
function isMobile() {
  return window.matchMedia('(pointer: coarse)').matches;
}
```

On load (and on resize/orientation change), if mobile:
- Hide the header `<select>` (`sessionSelector`)
- Enable swipe gesture listeners on the output area

### 2. Session Drawer (HTML + CSS)

Add a drawer panel that slides in from the left edge:

```html
<div class="session-drawer-overlay" id="sessionDrawerOverlay"></div>
<div class="session-drawer" id="sessionDrawer">
  <div class="session-drawer-header">Sessions</div>
  <div class="session-drawer-list" id="sessionDrawerList">
    <!-- Populated dynamically -->
  </div>
</div>
```

**CSS specs:**
- Drawer: `position: fixed; left: 0; top: 0; bottom: 0; width: 280px; transform: translateX(-100%); transition: transform 0.3s ease;`
- When open: `transform: translateX(0)`
- Overlay: semi-transparent black backdrop, fades in/out
- Respect `env(safe-area-inset-left)` and `env(safe-area-inset-top)` for notch devices
- Each session row: 48px height, status icon (colored dot), session name, branch tag, active indicator
- iOS visual style: blur backdrop, system fonts, standard list appearance

### 3. Swipe Gesture Detection

Detect left-to-right swipe starting from the left 30px edge of the screen:

```javascript
let touchStartX = 0;
let touchStartY = 0;
let touchStartTime = 0;
let isSwipingDrawer = false;

outputArea.addEventListener('touchstart', (e) => {
  const touch = e.touches[0];
  // Only trigger from left edge (30px zone)
  if (touch.clientX < 30) {
    touchStartX = touch.clientX;
    touchStartY = touch.clientY;
    touchStartTime = Date.now();
    isSwipingDrawer = true;
  }
}, { passive: true });

outputArea.addEventListener('touchmove', (e) => {
  if (!isSwipingDrawer) return;
  const dx = e.touches[0].clientX - touchStartX;
  const dy = Math.abs(e.touches[0].clientY - touchStartY);
  // Cancel if vertical movement dominates (user is scrolling)
  if (dy > dx) { isSwipingDrawer = false; return; }
  // Interactively move drawer with finger
  const progress = Math.min(dx / 280, 1);
  sessionDrawer.style.transform = `translateX(${-280 + (progress * 280)}px)`;
  sessionDrawerOverlay.style.opacity = progress * 0.4;
}, { passive: true });

outputArea.addEventListener('touchend', (e) => {
  if (!isSwipingDrawer) return;
  isSwipingDrawer = false;
  // If swiped > 80px or fast flick, open; otherwise snap closed
  const dx = e.changedTouches[0].clientX - touchStartX;
  const elapsed = Date.now() - touchStartTime;
  const velocity = dx / elapsed;
  if (dx > 80 || velocity > 0.5) {
    openSessionDrawer();
  } else {
    closeSessionDrawer();
  }
});
```

**Attach listeners to `document.body`** (not just `outputArea`) so the edge swipe works regardless of which element is under the finger. The 30px left-edge constraint prevents interference with normal scrolling.

### 4. Drawer Population

Reuse the session data already available from the WebSocket `sessions` message. When `updateSessionList()` is called, also update the drawer list:

```javascript
function updateSessionDrawer(sessions) {
  const list = document.getElementById('sessionDrawerList');
  if (!list) return;
  list.innerHTML = '';
  sessions.forEach(session => {
    const row = document.createElement('div');
    row.className = 'session-drawer-row' +
      (session.id === currentSessionId ? ' active' : '');
    row.innerHTML = `
      <span class="session-status-dot ${session.status}"></span>
      <span class="session-name">${session.name}</span>
      ${session.branch ? `<span class="session-branch">${session.branch}</span>` : ''}
    `;
    row.onclick = () => {
      document.getElementById('sessionSelector').value = session.id;
      switchSession();
      closeSessionDrawer();
    };
    list.appendChild(row);
  });
}
```

Call `updateSessionDrawer(sessions)` from inside the existing `updateSessionList()`.

### 5. Hide Header Selector on Mobile

```css
@media (pointer: coarse) {
  .session-selector {
    display: none;
  }
}
```

This hides the `<select>` on touch devices. Alternatively, use the JS `isMobile()` check at init time to add a `mobile` class to `<body>` and scope the CSS to `.mobile .session-selector { display: none; }`.

### 6. Open/Close Functions

```javascript
function openSessionDrawer() {
  const drawer = document.getElementById('sessionDrawer');
  const overlay = document.getElementById('sessionDrawerOverlay');
  drawer.style.transition = 'transform 0.3s ease';
  drawer.style.transform = 'translateX(0)';
  overlay.classList.add('show');
  // Haptic feedback
  navigator.vibrate?.(10);
}

function closeSessionDrawer() {
  const drawer = document.getElementById('sessionDrawer');
  const overlay = document.getElementById('sessionDrawerOverlay');
  drawer.style.transition = 'transform 0.3s ease';
  drawer.style.transform = 'translateX(-100%)';
  overlay.classList.remove('show');
}
```

Overlay tap closes the drawer. Swipe right-to-left on the open drawer also closes it.

## Acceptance Criteria

- [x] Swipe from left edge (0-30px) on mobile opens session drawer
- [x] Drawer shows all sessions with status dot, name, branch
- [x] Active session is visually highlighted
- [x] Tapping a session switches to it and closes the drawer
- [x] Overlay tap closes the drawer
- [x] Header `<select>` is hidden on mobile (pointer: coarse)
- [x] Header `<select>` remains visible on desktop — no behavior change
- [x] Drawer follows finger during swipe (interactive drag)
- [x] Fast flick (velocity > 0.5) opens drawer even if distance < 80px
- [x] Vertical scrolling is not hijacked (vertical movement cancels swipe)
- [x] Session list updates in real-time when WebSocket `sessions` message arrives
- [x] Status dots update when session status changes (waiting/processing/idle)
- [x] Drawer respects safe-area insets (notch, home indicator)
- [x] Drawer has iOS-native visual style (blur backdrop, system fonts)

## Technical Considerations

- **Gesture conflict:** The 30px left-edge zone + vertical-cancellation logic prevents conflicts with normal scrolling. iOS Safari also uses left-edge swipe for back navigation — setting the zone to 30px (vs. Safari's ~20px) should coexist, but worth testing. If conflict occurs, reduce to 20px or require a slightly longer horizontal travel before committing.
- **Performance:** Use `transform` and `opacity` for animations (GPU-composited, no layout thrash). Set `will-change: transform` on the drawer.
- **Passive listeners:** Use `{ passive: true }` on touch handlers to avoid scroll jank. If `preventDefault` is needed on `touchmove` to prevent page scroll while dragging, use `{ passive: false }` only on that handler.
- **State sync:** The drawer reads from the same session data as the `<select>`. No new WebSocket messages needed — just hook into `updateSessionList()`.

## Files Modified

- `public/index.html` — All changes (HTML structure, CSS styles, JS logic)

## References

- Existing session switching: `switchSession()` at line ~2364
- Session data population: `updateSessionList()` at line ~2326
- iOS-native styling patterns: throughout the existing CSS (blur backdrops, system fonts, safe-area insets)
