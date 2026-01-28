---
title: "feat: Seamless Phone-Only Authentication"
type: feat
date: 2026-01-27
---

# Seamless Phone-Only Authentication

## Overview

Enable re-authentication from phone when Mac mini is running for weeks and user has no laptop access. iOS Safari clears localStorage after 7 days of inactivity, and current sessionStorage clears on browser close.

## Problem Statement

**Current pain:**
- Token stored in `sessionStorage` (clears when browser closes)
- iOS Safari clears script-writable storage after 7 days of inactivity
- 64-character hex token impossible to remember
- User must access Mac mini to retrieve token - but they're away with only phone

**User scenario:**
> "I leave my Mac mini running Claude sessions for weeks. When I'm traveling with just my phone and need to re-auth, I'm completely locked out."

## Proposed Solution: Belt and Suspenders

Implement three complementary mechanisms:

```
┌─────────────────────────────────────────────────────────────────┐
│                    Defense in Depth                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  Layer 1: PWA (Add to Home Screen)                              │
│  ├── NOT subject to 7-day eviction                              │
│  ├── Separate storage from Safari                               │
│  └── Works indefinitely as long as PWA exists                   │
│                                                                  │
│  Layer 2: Memorable Passphrase                                  │
│  ├── "laser-monkey-pizza-42" instead of hex                     │
│  ├── User can memorize or write down                            │
│  └── Type from memory on any device                             │
│                                                                  │
│  Layer 3: iOS Password Autofill                                 │
│  ├── Save passphrase to iCloud Keychain                         │
│  ├── Syncs across all Apple devices                             │
│  └── Face ID to autofill                                        │
│                                                                  │
│  Layer 4: HTTP-only Cookie (bonus)                              │
│  ├── Survives browser close (unlike sessionStorage)             │
│  └── 30-day expiry with sliding window                          │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Technical Approach

### Phase 1: PWA Manifest + Install Prompt

**Files:**
- `public/manifest.json` (new)
- `public/index.html` (add manifest link + install prompt)
- `public/icon-192.png`, `public/icon-512.png` (new - use existing touch icon)

**manifest.json:**
```json
{
  "name": "Claude Remote",
  "short_name": "Claude",
  "description": "Mobile companion for Claude Code sessions",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#1a1a2e",
  "theme_color": "#6366f1",
  "icons": [
    {"src": "/icon-192.png", "sizes": "192x192", "type": "image/png"},
    {"src": "/icon-512.png", "sizes": "512x512", "type": "image/png"}
  ]
}
```

**Install prompt (after first successful auth):**
```javascript
// Detect if running as PWA
const isStandalone = window.navigator.standalone ||
                     window.matchMedia('(display-mode: standalone)').matches;

if (!isStandalone && !localStorage.getItem('pwa_prompt_dismissed')) {
  showInstallBanner();
}
```

### Phase 2: Memorable Passphrase

**Server startup generates passphrase:**
```javascript
// server.js
const PASSPHRASE = process.env.AUTH_PASSPHRASE || generatePassphrase();

function generatePassphrase() {
  // EFF short wordlist (1296 words) - more memorable than full list
  const words = ['laser', 'monkey', 'pizza', 'thunder', ...]; // 1296 words
  const phrase = Array(4).fill(0).map(() =>
    words[crypto.randomInt(words.length)]
  ).join('-');
  const num = crypto.randomInt(10, 100);
  return `${phrase}-${num}`;
}

console.log(`
╔════════════════════════════════════════════════════════════╗
║  Passphrase: ${PASSPHRASE.padEnd(40)}║
║  (memorize this or save to password manager)               ║
╚════════════════════════════════════════════════════════════╝
`);
```

**Validation accepts both token and passphrase:**
```javascript
function validateAuth(input) {
  // Check if it's the passphrase
  if (input === PASSPHRASE) {
    return true;
  }
  // Check if it's the hex token
  if (input.length >= 32) {
    return crypto.timingSafeEqual(
      Buffer.from(input),
      Buffer.from(AUTH_TOKEN)
    );
  }
  return false;
}
```

### Phase 3: iOS Password Autofill

**Update login form for autofill compatibility:**
```html
<form id="authForm" action="#" method="POST" autocomplete="on">
  <!-- Hidden username for iOS autofill (requires username+password pair) -->
  <input type="text"
         name="username"
         value="claude-remote"
         autocomplete="username"
         readonly
         style="position:absolute;left:-9999px">

  <!-- Token/passphrase input -->
  <input type="password"
         id="token"
         name="password"
         autocomplete="current-password"
         placeholder="Token or passphrase"
         required>

  <button type="submit">Connect</button>
</form>
```

**Why this works:**
- iOS requires `autocomplete="username"` + `autocomplete="current-password"` pair
- Hidden username satisfies iOS requirements
- Password field triggers Keychain save prompt
- Face ID authenticates future autofills

### Phase 4: HTTP-only Cookie + CSRF Protection

**Server sets cookie on successful auth:**
```javascript
app.post('/auth', (req, res) => {
  const { password } = req.body;

  if (validateAuth(password)) {
    const sessionId = crypto.randomUUID();
    sessions.set(sessionId, { created: Date.now() });

    res.cookie('session', sessionId, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      maxAge: 30 * 24 * 60 * 60 * 1000 // 30 days
    });

    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Invalid credentials' });
  }
});
```

**WebSocket accepts cookie OR message auth:**
```javascript
wss.on('upgrade', (request, socket, head) => {
  const cookies = parseCookies(request.headers.cookie);
  const sessionId = cookies.session;

  if (sessionId && sessions.has(sessionId)) {
    // Cookie auth - pre-authenticated
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.isAuthenticated = true;
      wss.emit('connection', ws, request);
    });
  } else {
    // Will require message-based auth
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  }
});
```

## User Flows

### Happy Path: PWA User (90% of cases)
```
User added app to home screen
  ↓
Opens via home screen icon (not Safari)
  ↓
PWA localStorage has token (never cleared by iOS)
  ↓
Auto-connects immediately
  ↓
No auth needed for weeks/months
```

### Recovery Path: PWA Deleted or New Device
```
PWA storage lost or new device
  ↓
User opens app, sees login form
  ↓
iOS shows "Passwords" suggestion in keyboard
  ↓
User taps, Face ID authenticates
  ↓
Passphrase auto-filled
  ↓
Connected!
```

### Fallback Path: No Keychain Entry
```
No saved passphrase in Keychain
  ↓
User types passphrase from memory: "laser-monkey-pizza-42"
  ↓
iOS prompts "Save Password?"
  ↓
User saves for future
  ↓
Connected!
```

## Storage Comparison

| Storage Type | Survives 7 Days | Survives Browser Close | PWA Separate | Our Usage |
|--------------|-----------------|------------------------|--------------|-----------|
| sessionStorage | NO | NO | YES | Remove |
| localStorage | NO | YES | YES | Settings only |
| HTTP-only Cookie | YES | YES | NO* | Session auth |
| PWA localStorage | YES | YES | YES | Token storage |
| iCloud Keychain | YES | YES | Shared | Passphrase backup |

*Cookies are shared between Safari and PWA when domain matches

## Acceptance Criteria

### Must Have
- [ ] PWA manifest enables "Add to Home Screen" with persistent storage
- [ ] Passphrase displayed on server startup (memorable format)
- [ ] Passphrase accepted alongside hex token for auth
- [ ] Token input works with iOS password autofill
- [ ] Install prompt shown after first successful auth
- [ ] Visual indicator shows PWA vs Safari mode

### Should Have
- [ ] HTTP-only cookie for session persistence
- [ ] Cookie refreshed on each visit (sliding expiration)
- [ ] Rate limiting on auth attempts (5/min/IP)

### Nice to Have
- [ ] Service worker for offline "last known state" display
- [ ] Push notification when session needs attention

## Security Considerations

1. **Passphrase entropy:** 4 words + 2-digit number = ~59 bits (sufficient)
2. **Rate limiting:** Prevents brute force on passphrase
3. **CSRF:** Cookie auth requires CSRF token for POST endpoints
4. **No plaintext storage:** Passphrase kept in memory, not written to disk

## Files to Modify

| File | Changes |
|------|---------|
| `server.js` | Add passphrase generation, cookie auth, `/auth` endpoint |
| `public/index.html` | Update form for autofill, add install prompt, detect standalone mode |
| `public/manifest.json` | New file - PWA manifest |
| `public/icon-192.png` | New file - PWA icon |
| `public/icon-512.png` | New file - PWA icon |

## References

- [WebKit: Updates to Storage Policy](https://webkit.org/blog/14403/updates-to-storage-policy/) - iOS 7-day rule explained
- [PWA on iOS - Current Status & Limitations](https://brainhub.eu/library/pwa-on-ios) - PWA storage isolation
- [iOS Password Autofill Requirements](https://developer.apple.com/documentation/security/password_autofill)
