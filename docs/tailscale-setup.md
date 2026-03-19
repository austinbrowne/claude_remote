# Tailscale Setup Guide — Claude Remote on Linux

Quick setup to access Claude Remote from your phone via Tailscale.

---

## 1. Install Tailscale (Linux — Fedora)

```bash
# Install
sudo dnf install -y tailscale

# Enable and start the daemon
sudo systemctl enable --now tailscaled

# Authenticate (opens browser)
sudo tailscale up
```

After authenticating, verify:

```bash
tailscale status
tailscale ip -4    # Note this IP — you'll use it on your phone
```
100.113.18.8

---

## 2. Install Tailscale on Your Phone

1. **iOS**: App Store → search "Tailscale" → Install
2. **Android**: Play Store → search "Tailscale" → Install
3. Open the app and sign in with the **same account** you used on the Linux machine
4. Verify both devices appear in your tailnet (check Tailscale app or https://login.tailscale.com/admin/machines)

---

## 3. Start Claude Remote

On your Linux machine:

```bash
# Terminal 1: Start tmux and Claude
tmux new -s claude
claude

# Terminal 2 (or tmux split with Ctrl+B %): Start the server
cd ~/Projects/claude_remote
./start.sh
```

The server starts on port 3456.

---

## 4. Connect from Phone

Open your phone browser and go to:

```
http://<tailscale-ip>:3456
```

Replace `<tailscale-ip>` with the IP from step 1 (e.g., `http://100.64.1.23:3456`).

Enter your AUTH_TOKEN when prompted.

---

## 5. Optional: MagicDNS (Use Hostname Instead of IP)

Enable MagicDNS in the Tailscale admin console:
https://login.tailscale.com/admin/dns

Then access via hostname:

```
http://<hostname>:3456
```

Find your hostname with:

```bash
tailscale status --json | jq -r '.Self.DNSName'
```

---

## 6. Optional: HTTPS with Tailscale Certs

For encrypted token transport (recommended):

```bash
# Get your tailnet hostname
HOSTNAME=$(tailscale status --json | jq -r '.Self.DNSName' | sed 's/\.$//')

# Generate TLS certificate (auto-renewed by Tailscale)
sudo tailscale cert "$HOSTNAME"

# Certs are saved to:
#   /var/lib/tailscale/certs/$HOSTNAME.crt
#   /var/lib/tailscale/certs/$HOSTNAME.key
```

Then set env vars in `.env`:

```bash
TLS_CERT=/var/lib/tailscale/certs/$HOSTNAME.crt
TLS_KEY=/var/lib/tailscale/certs/$HOSTNAME.key
```

Access via `https://<hostname>:3456`.

---

## 7. Optional: Firewall (Fedora firewalld)

If port 3456 is blocked by the firewall:

```bash
# Allow port 3456 on the Tailscale interface only
sudo firewall-cmd --zone=trusted --add-interface=tailscale0 --permanent
sudo firewall-cmd --zone=trusted --add-port=3456/tcp --permanent
sudo firewall-cmd --reload
```

This restricts access to Tailscale traffic only — port 3456 won't be exposed on your LAN.

---

## 8. Optional: Tailscale ACLs

For extra security, restrict which devices can reach port 3456:

1. Go to https://login.tailscale.com/admin/acls
2. Add a rule like:

```json
{
  "action": "accept",
  "src": ["tag:phone"],
  "dst": ["tag:server:3456"]
}
```

3. Tag your devices accordingly in the Machines tab.

---

## Troubleshooting

| Problem | Check |
|---------|-------|
| Can't reach server from phone | `tailscale ping <linux-ip>` from phone |
| "Connection refused" | Is `./start.sh` running? Check `ss -tlnp \| grep 3456` |
| Auth token rejected | Check `.env` has `AUTH_TOKEN=...` with 32+ chars |
| tmux sessions not discovered | Is Claude running inside tmux? Check `tmux list-panes` |
| Firewall blocking | `sudo firewall-cmd --list-all --zone=trusted` |
