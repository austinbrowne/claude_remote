---
status: complete
priority: p1
issue_id: "004"
tags: [code-review, security, authentication]
dependencies: []
---

# Authentication Token Exposed in WebSocket URL

## Problem Statement

The auth token is passed as a URL query parameter in the WebSocket connection URL. This causes the token to appear in server access logs, browser history, cloudflared tunnel logs, network monitoring tools, and potentially Referer headers.

**Why it matters:** Tokens in URLs have a long history of causing credential leakage through logs and caches.

## Findings

**Location:** `/Users/austin/Git_Repos/claude_remote/public/index.html:802-803`

```javascript
const wsUrl = `${protocol}//${window.location.host}?token=${encodeURIComponent(authToken)}`;
ws = new WebSocket(wsUrl);
```

**Server-side:** `/Users/austin/Git_Repos/claude_remote/server.js:281-284`
```javascript
const url = new URL(req.url, `http://${req.headers.host}`);
const token = url.searchParams.get('token');
```

**Evidence:**
- Token visible in WebSocket URL
- Logged in server startup banner (first 10 chars)
- Will appear in cloudflared logs
- Browser history contains full token

**Discovered by:** security-sentinel, architecture-strategist agents

## Proposed Solutions

### Option A: Authenticate via First Message (Recommended)
**Pros:** Token never in URL, standard WebSocket auth pattern
**Cons:** Slightly more complex handshake
**Effort:** Medium
**Risk:** Low

```javascript
// Client
ws = new WebSocket(`${protocol}//${window.location.host}`);
ws.onopen = () => {
  ws.send(JSON.stringify({ action: 'auth', token: authToken }));
};

// Server
wss.on('connection', (ws, req) => {
  let authenticated = false;
  ws.on('message', (message) => {
    const msg = JSON.parse(message);
    if (!authenticated && msg.action === 'auth') {
      if (msg.token === AUTH_TOKEN) {
        authenticated = true;
        // Initialize client
      } else {
        ws.close(4001, 'Unauthorized');
      }
    }
    // Only process other messages if authenticated
  });
});
```

### Option B: Use WebSocket Subprotocol
**Pros:** Standard mechanism
**Cons:** Less flexible, still somewhat visible
**Effort:** Small
**Risk:** Medium

```javascript
ws = new WebSocket(wsUrl, [`auth-${authToken}`]);
```

## Recommended Action

_To be filled during triage_

## Technical Details

**Affected files:** `server.js`, `public/index.html`
**Components:** WebSocket authentication
**Database changes:** None

## Acceptance Criteria

- [ ] Token not present in WebSocket URL
- [ ] Token not logged to console on server startup
- [ ] Authentication happens via message or header

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-01-25 | Created finding | URL parameters are logged everywhere |

## Resources

- OWASP: A02 Cryptographic Failures
