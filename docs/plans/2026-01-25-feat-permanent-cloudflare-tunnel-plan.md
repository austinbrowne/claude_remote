---
title: "feat: Set Up Permanent Cloudflare Named Tunnel"
type: feat
date: 2026-01-25
---

# Set Up Permanent Cloudflare Named Tunnel

## Overview

Replace the temporary `trycloudflare.com` quick tunnel with a permanent named tunnel using a custom subdomain on your existing Cloudflare domain. This gives you a stable URL like `claude.yourdomain.com` that never changes.

## Problem Statement

Currently, the tunnel URL changes every time cloudflared restarts (e.g., `vegetarian-lol-rate-legs.trycloudflare.com`). This means:
- You have to update the URL on your phone each time
- Bookmarks become stale
- No consistent, memorable URL

## Proposed Solution

Create a Cloudflare Named Tunnel with:
- A permanent subdomain on your domain (e.g., `claude.yourdomain.com`)
- Persistent credentials stored locally
- Auto-start on boot via launchd or pm2

## Implementation Steps

### Phase 1: Create Named Tunnel

#### 1.1 Authenticate with Cloudflare

```bash
cloudflared tunnel login
```

This opens browser to authenticate. Select your domain. Certificate saves to `~/.cloudflared/cert.pem`.

#### 1.2 Create the Tunnel

```bash
cloudflared tunnel create claude-remote
```

**Output will show:**
- Tunnel UUID (e.g., `ae21a96c-24d1-4ce8-a6ba-962cba5976d3`)
- Credentials file path (e.g., `~/.cloudflared/<UUID>.json`)

Save the UUID for the next step.

#### 1.3 Route DNS to Tunnel

```bash
cloudflared tunnel route dns claude-remote claude.yourdomain.com
```

Replace `yourdomain.com` with your actual domain. This creates a CNAME record automatically.

### Phase 2: Configure the Tunnel

#### 2.1 Create Configuration File

Create `~/.cloudflared/config.yml`:

```yaml
tunnel: <YOUR-TUNNEL-UUID>
credentials-file: /Users/austin/.cloudflared/<YOUR-TUNNEL-UUID>.json

ingress:
  - hostname: claude.yourdomain.com
    service: http://localhost:3456
    originRequest:
      connectTimeout: 30s
  - service: http_status:404
```

**Important:** Replace:
- `<YOUR-TUNNEL-UUID>` with the UUID from step 1.2
- `claude.yourdomain.com` with your chosen subdomain

#### 2.2 Validate Configuration

```bash
cloudflared tunnel ingress validate
```

#### 2.3 Test the Tunnel

```bash
cloudflared tunnel run claude-remote
```

Visit `https://claude.yourdomain.com` to verify it works.

### Phase 3: Run Persistently

Choose ONE of these options:

#### Option A: macOS Launch Agent (Recommended)

```bash
cloudflared service install
```

This installs a LaunchAgent that starts the tunnel on user login.

**Control commands:**
```bash
# Start
launchctl start com.cloudflare.cloudflared

# Stop
launchctl stop com.cloudflare.cloudflared

# Check status
launchctl list | grep cloudflare
```

#### Option B: pm2 (if you prefer)

```bash
pm2 start cloudflared --name "cloudflare-tunnel" -- tunnel run claude-remote
pm2 save
pm2 startup
```

### Phase 4: Update Server Binding (Security)

Edit `server.js` to bind only to localhost:

```javascript
// server.js - change the listen call
server.listen(PORT, '127.0.0.1', () => {
  // ...
});
```

This ensures traffic can ONLY come through the Cloudflare tunnel, not direct IP access.

### Phase 5: Secure Credentials

```bash
chmod 600 ~/.cloudflared/*.json
chmod 600 ~/.cloudflared/cert.pem
```

## Acceptance Criteria

- [ ] Named tunnel created with permanent UUID
- [ ] DNS CNAME record points subdomain to tunnel
- [ ] `config.yml` configured with correct tunnel UUID and hostname
- [ ] Tunnel starts automatically on boot/login
- [ ] Server accessible at `https://claude.yourdomain.com`
- [ ] Server binds to localhost only (127.0.0.1)
- [ ] Credentials files have restricted permissions (600)

## Quick Reference

| Command | Purpose |
|---------|---------|
| `cloudflared tunnel list` | List all tunnels |
| `cloudflared tunnel info claude-remote` | Get tunnel status |
| `cloudflared tunnel run claude-remote` | Run manually |
| `cloudflared service install` | Install as service |
| `cloudflared tunnel cleanup claude-remote` | Clean stale connections |

## Optional: Cloudflare Access (Zero Trust)

For additional security, you can add Cloudflare Access to require authentication before reaching your server. This is configured in the Cloudflare Zero Trust dashboard, not in this plan.

## Files Changed

| File | Change |
|------|--------|
| `~/.cloudflared/config.yml` | New - tunnel configuration |
| `~/.cloudflared/<UUID>.json` | New - tunnel credentials (auto-created) |
| `server.js` | Modify - bind to 127.0.0.1 only |

## References

- [Cloudflare Tunnel Local Management](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/tunnel-guide/local/)
- [Run as macOS Service](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/run-tunnel/as-a-service/macos/)
