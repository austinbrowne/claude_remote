const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises; // Async file operations
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');
const {
  SPINNER_VERBS, MAX_READ_SIZE, HISTORY_LINE_LIMIT, ErrorCodes,
  getRandomSpinnerVerb, stripAnsi, formatMcpToolName, sanitizeMcpInput,
  sendError, secureCompare, calculateContextPercentage
} = require('./lib/utils');
const { discoverCommands } = require('./lib/commands');
const {
  sendControlCharToTty, prepareSessionForInjection, injectCommandToTty,
  selectOptionInTty, sendEscapeKeyToTty, sendModeToggle,
  injectCommandLegacy, sendEscapeKeyLegacy
} = require('./lib/command-injection');
const { createFileApiRouter } = require('./lib/file-api');
const {
  CLAUDE_DIR, getActiveClaude, getGitBranch, loadAllowedTools,
  needsPermission, discoverSessions, getSessionStatus
} = require('./lib/session-discovery');
const {
  createParserState, detectMilestone, extractMilestones, parseLogEntry
} = require('./lib/log-parser');
const { createWatcher } = require('./lib/watcher');

const app = express();
const PORT = process.env.PORT || 3456;
const AUTH_TOKEN = process.env.AUTH_TOKEN;
if (!AUTH_TOKEN || AUTH_TOKEN.length < 32) {
  console.error('ERROR: Set AUTH_TOKEN environment variable (minimum 32 characters)');
  console.error('Generate one with: openssl rand -hex 32');
  process.exit(1);
}

// Parser state for cross-entry correlations (subagent descriptions, task IDs)
const parserState = createParserState();

// Create HTTP server for both Express and WebSocket
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());

// Security headers (no dependency required)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // CSP allows inline styles (needed for mobile PWA) and Prism CDN
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; " +
    "style-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; " +
    "connect-src 'self' ws: wss:; " +
    "img-src 'self' data:; " +
    "frame-ancestors 'none'"
  );
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Store active WebSocket connections
const clients = new Map();

// Store active Claude sessions being watched
const activeSessions = new Map();

// watchSession, unwatchSession are created via createWatcher() after broadcastToClients is defined.
// See the watcher initialization block below broadcastToClients.

// ============================================
// Clear & Resume
// ============================================

// Polling fallback: scan logs directory for a new .jsonl file after /clear
function checkForNewSessionAfterClear(oldSessionId) {
  const sd = activeSessions.get(oldSessionId);
  if (!sd || !sd.pendingClear) return;

  const logsDir = sd.pendingClear.logsDir;
  const oldLogFile = sd.pendingClear.oldLogFile;
  const startedAt = sd.pendingClear.startedAt;

  fsp.readdir(logsDir).then(async (files) => {
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      const fullPath = path.join(logsDir, file);
      if (fullPath === oldLogFile) continue;

      try {
        const stats = await fsp.stat(fullPath);
        if (stats.mtimeMs > startedAt) {
          const newSessionId = path.basename(file, '.jsonl');
          handleNewSessionAfterClear(oldSessionId, newSessionId, fullPath);
          return;
        }
      } catch { /* file disappeared */ }
    }
  }).catch(() => { /* dir read error */ });
}

// Core transition: old session → new session after /clear
async function handleNewSessionAfterClear(oldSessionId, newSessionId, newLogFile) {
  const sd = activeSessions.get(oldSessionId);
  if (!sd || !sd.pendingClear) return;

  // Prevent double-fire (both watcher and poll may trigger)
  const pending = sd.pendingClear;
  sd.pendingClear = null;

  // Clear timeout and polling interval
  if (pending.timeout) clearTimeout(pending.timeout);
  if (pending.pollInterval) clearInterval(pending.pollInterval);

  console.log(`[Clear&Resume] Transitioning: ${oldSessionId.substring(0, 8)} → ${newSessionId.substring(0, 8)}`);

  // Transfer client watch registrations: old session → new session
  for (const [ws, clientData] of clients) {
    if (clientData.watchingSessions.has(oldSessionId)) {
      clientData.watchingSessions.delete(oldSessionId);
      clientData.watchingSessions.add(newSessionId);
    }
  }

  // Tear down old session watchers
  unwatchSession(oldSessionId);

  // Watch the new session (retry — log file may not have cwd written yet)
  let newSession = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    newSession = await watchSession(newSessionId);
    if (newSession) break;
    await new Promise(r => setTimeout(r, 1000));
  }

  if (!newSession) {
    console.warn(`[Clear&Resume] Could not discover new session ${newSessionId.substring(0, 8)} after retries`);
    broadcastToClients({
      type: 'clear_and_resume_progress',
      sessionId: newSessionId,
      step: 'failed',
      message: 'New session created but could not be watched'
    });
    return;
  }

  // Broadcast session_replaced to all watching clients
  broadcastToClients({
    type: 'session_replaced',
    oldSessionId,
    newSessionId,
    session: newSession
  });

  // Broadcast progress: switching
  broadcastToClients({
    type: 'clear_and_resume_progress',
    sessionId: newSessionId,
    step: 'switching',
    message: 'New session detected, resuming...'
  });

  // After a brief delay, inject the resume prompt
  setTimeout(async () => {
    try {
      const newSd = activeSessions.get(newSessionId);
      const tty = newSd?.session?.tty || pending.tty;
      if (tty) {
        const resumePrompt = 'Read .compact-state.md in the project root if it exists and continue the previous task. If it does not exist, ask what I would like to work on. If the file exists: review it thoroughly, then run `git status` and `git diff --stat` to verify the codebase matches. Pick up from the Next Steps section. Do not re-explain what was already done — just continue the work.';
        await injectCommandToTty(resumePrompt, tty);
        console.log(`[Clear&Resume] Resume prompt injected to ${tty}`);
      }
    } catch (err) {
      console.error(`[Clear&Resume] Failed to inject resume prompt: ${err.message}`);
    }

    broadcastToClients({
      type: 'clear_and_resume_progress',
      sessionId: newSessionId,
      step: 'complete',
      message: 'Context cleared and resumed'
    });
  }, 2000);
}

// Message types excluded from recentEvents replay buffer:
// - Ephemeral: transient status that's stale on replay
// - Meta: replay/recovery messages that would cause recursion if replayed (CONS-001)
const EXCLUDED_FROM_REPLAY = new Set([
  'session_status', 'typing', 'heartbeat',           // ephemeral
  'session_delta', 'pending_prompts', 'session_suspect', 'session_alive'  // meta/recovery
]);
const RECENT_EVENTS_CAP = 100;
const COMPACTION_SLACK = 20; // Amortized compaction: compact when cap + slack exceeded

function broadcastToClients(message) {
  // Log subagent-related messages for debugging
  if (message.type?.startsWith('subagent')) {
    console.log(`[BROADCAST] ${message.type} agentId=${message.agentId} dataType=${message.data?.type}`);
  }

  // Look up session to get seq counter
  const sessionData = message.sessionId ? activeSessions.get(message.sessionId) : null;
  let seq = null;

  if (sessionData) {
    seq = ++sessionData.lastBroadcastSeq;

    // Update authoritative prompt state before broadcasting
    try {
      updatePromptState(sessionData, message);
    } catch (e) {
      console.error('[Broadcast] updatePromptState failed:', e.message);
    }

    // Store in recent events buffer (skip excluded types that are stale/dangerous on replay)
    if (!EXCLUDED_FROM_REPLAY.has(message.type)) {
      const stored = { seq, ...message, timestamp: Date.now() };
      sessionData.recentEvents.push(stored);
      // Periodic compaction — amortized O(n), not per-append splice
      if (sessionData.recentEvents.length > RECENT_EVENTS_CAP + COMPACTION_SLACK) {
        sessionData.recentEvents = sessionData.recentEvents.slice(-RECENT_EVENTS_CAP);
      }
    }
  }

  const enriched = seq != null ? { ...message, seq } : message;
  const data = JSON.stringify(enriched);
  clients.forEach((clientData, ws) => {
    if (ws.readyState === WebSocket.OPEN && !clientData.pauseBroadcast) {
      if (!message.sessionId || clientData.watchingSessions.has(message.sessionId)) {
        try {
          ws.send(data);
        } catch (e) {
          // Send failed (connection closing) — skip this client
        }
      }
    }
  });
}

// Track server-side prompt state for authoritative recovery on reconnect
function updatePromptState(sessionData, event) {
  if (!sessionData || !event) return;

  if (event.type === 'permission_request' || event.type === 'ask_user_question') {
    // toolUseId is reliable for permission_request (from log-parser.js block.id)
    // ask_user_question has no correlation ID — use seq-based fallback
    const promptId = event.toolUseId || `prompt-${sessionData.lastBroadcastSeq}`;
    sessionData.pendingPrompts.set(promptId, {
      promptId,
      type: event.type,
      tool: event.tool,
      toolUseId: event.toolUseId,
      data: event,
      seq: sessionData.lastBroadcastSeq,
      timestamp: Date.now()
    });
  }

  if (event.type === 'tool_result' && event.toolUseId) {
    sessionData.pendingPrompts.delete(event.toolUseId);
  }

  if (event.type === 'user') {
    // Clear oldest ask_user_question (FIFO — acceptable since AskUserQuestion
    // prompts are rare and sequential in practice. toolUseId-based correlation
    // is not available in the JSONL format for these events.)
    for (const [id, prompt] of sessionData.pendingPrompts) {
      if (prompt.type === 'ask_user_question') {
        sessionData.pendingPrompts.delete(id);
        break;
      }
    }
  }
}

// ============================================
// Watcher initialization (depends on broadcastToClients)
// ============================================
const { watchSession, unwatchSession } = createWatcher({
  activeSessions,
  broadcastToClients,
  parseLogEntry,
  detectMilestone,
  parserState,
  getSessionStatus,
  loadAllowedTools,
  discoverSessions,
  getActiveClaude,
  onNewSessionAfterClear: handleNewSessionAfterClear
});

// Build the full claudeState object for a session
function buildClaudeState(sessionId) {
  const sd = activeSessions.get(sessionId);
  if (!sd) return null;

  const subagents = {};
  for (const [id, info] of sd.subagentInfo) {
    const entry = {
      status: info.status,
      description: info.description,
      agentType: info.agentType,
      currentTool: info.currentTool || null,
      inputTokens: info.inputTokens || 0,
      outputTokens: info.outputTokens || 0,
      startTime: info.startTime,
      lastActivity: info.lastActivity
    };
    if (info.teamName) entry.teamName = info.teamName;
    if (info.memberName) entry.memberName = info.memberName;
    subagents[id] = entry;
  }

  return {
    session: {
      id: sessionId,
      name: sd.session.name,
      cwd: sd.session.cwd,
      branch: sd.session.branch,
      tty: sd.session.tty,
      pid: sd.session.pid
    },
    status: sd.lastStatus || 'unknown',
    mode: sd.mode || 'default',
    contextPercentage: sd.contextPercentage || 0,
    permissions: {
      allowedTools: Array.from(sd.allowedTools || []),
      sessionGranted: Array.from(sd.sessionGranted || []),
      mode: sd.mode || 'default'
    },
    subagents,
    tasks: Array.from(sd.tasks?.values() || []),
    team: sd.activeTeam ? {
      name: sd.activeTeam.name,
      members: Object.fromEntries(sd.activeTeam.members),
      recentMessages: sd.teamMessages?.slice(-10) || []
    } : null,
    lastActivity: new Date().toISOString()
  };
}

// Broadcast claudeState update to all clients watching a session
function broadcastClaudeState(sessionId) {
  const state = buildClaudeState(sessionId);
  if (state) {
    broadcastToClients({
      type: 'claude_state',
      sessionId,
      state
    });
  }
}

// Periodic claudeState sync — corrects any drift from missed individual messages
const CLAUDE_STATE_SYNC_MS = 30000;
setInterval(() => {
  for (const [sessionId] of activeSessions) {
    broadcastClaudeState(sessionId);
  }
}, CLAUDE_STATE_SYNC_MS);

// Periodic liveness check: detect dead sessions and auto-transition to replacements
// Uses failCount grace period: 1st failure = warn (session_suspect), 3rd = dead
const SESSION_LIVENESS_CHECK_MS = 15000;
const PROMPT_TTL_MS = 10 * 60 * 1000; // 10 minutes — expire stale prompts with no watchers
let livenessCheckRunning = false;

setInterval(async () => {
  if (activeSessions.size === 0 || livenessCheckRunning) return;
  livenessCheckRunning = true;
  try {
    const activeProcesses = await getActiveClaude();
    const activeTtys = new Set(activeProcesses.map(p => p.tty));

    // Collect sessions by liveness state (don't mutate activeSessions during iteration)
    const deadSessions = []; // failCount >= 3, ready to clean up
    for (const [sessionId, sd] of activeSessions) {
      const tty = sd.session?.tty;
      if (tty && !activeTtys.has(tty)) {
        sd.failCount++;

        if (sd.failCount === 1) {
          // First failure — warn clients but don't kill session
          console.log(`[Liveness] Session ${sessionId.substring(0, 8)} suspect (failCount: ${sd.failCount})`);
          broadcastToClients({ type: 'session_suspect', sessionId });
        }

        if (sd.failCount >= 3) {
          // 3 consecutive failures (~45s) — declare dead
          deadSessions.push({ sessionId, cwd: sd.session.cwd });
        }
      } else {
        // Process alive — reset failCount and notify if recovering
        if (sd.failCount > 0) {
          console.log(`[Liveness] Session ${sessionId.substring(0, 8)} recovered (was failCount: ${sd.failCount})`);
          broadcastToClients({ type: 'session_alive', sessionId });
        }
        sd.failCount = 0;
      }

      // Prompt TTL: expire stale prompts when no clients are watching
      if (sd.pendingPrompts.size > 0) {
        const hasWatchers = [...clients.values()].some(c => c.watchingSessions.has(sessionId));
        if (!hasWatchers) {
          const now = Date.now();
          for (const [promptId, prompt] of sd.pendingPrompts) {
            if (now - prompt.timestamp > PROMPT_TTL_MS) {
              sd.pendingPrompts.delete(promptId);
            }
          }
        }
      }
    }

    for (const { sessionId, cwd } of deadSessions) {
      console.log(`[Liveness] Session ${sessionId.substring(0, 8)} declared dead (failCount >= 3)`);

      // Find clients watching this session before cleanup
      const watchingClients = [];
      for (const [ws, clientData] of clients) {
        if (clientData.watchingSessions.has(sessionId)) {
          watchingClients.push({ ws, clientData });
        }
      }

      if (watchingClients.length === 0) {
        // No clients watching — just clean up
        unwatchSession(sessionId);
        continue;
      }

      // Clean up the dead session
      unwatchSession(sessionId);

      // Try to find a replacement session (same cwd, active process)
      const sessions = await discoverSessions();
      const replacement = sessions.find(s => s.cwd === cwd);

      if (replacement) {
        // Replacement liveness pre-check: verify replacement is actually alive
        const replacementAlive = activeTtys.has(replacement.tty);
        if (!replacementAlive) {
          console.log(`[Liveness] Replacement ${replacement.id.substring(0, 8)} failed pre-check — notifying session_ended`);
          for (const { ws, clientData } of watchingClients) {
            clientData.watchingSessions.delete(sessionId);
            try {
              ws.send(JSON.stringify({ type: 'session_ended', sessionId }));
              ws.send(JSON.stringify({ type: 'sessions', data: sessions }));
            } catch (e) { console.error('[Liveness] ws.send failed:', e.message); }
          }
          continue;
        }

        console.log(`[Liveness] Auto-transitioning to replacement: ${replacement.id.substring(0, 8)}`);
        const newSession = await watchSession(replacement.id);
        if (newSession) {
          for (const { ws, clientData } of watchingClients) {
            clientData.watchingSessions.delete(sessionId);
            clientData.watchingSessions.add(replacement.id);
            try {
              ws.send(JSON.stringify({
                type: 'session_replaced',
                oldSessionId: sessionId,
                newSessionId: replacement.id,
                session: newSession
              }));
            } catch (e) { console.error('[Liveness] ws.send failed:', e.message); }
          }
        }
      } else {
        // No replacement — notify clients that session ended
        for (const { ws, clientData } of watchingClients) {
          clientData.watchingSessions.delete(sessionId);
          try {
            ws.send(JSON.stringify({ type: 'session_ended', sessionId }));
            ws.send(JSON.stringify({ type: 'sessions', data: sessions }));
          } catch (e) { console.error('[Liveness] ws.send failed:', e.message); }
        }
      }
    }
  } catch (e) {
    console.error('[Liveness] Check failed:', e.message);
  } finally {
    livenessCheckRunning = false;
  }
}, SESSION_LIVENESS_CHECK_MS);

// Clean up stale WebSocket connections that haven't pinged in 60 seconds.
// Prevents duplicate broadcasts when iOS app reconnects without closing old connection.
const CLIENT_STALE_MS = 60000;
setInterval(() => {
  const now = Date.now();
  for (const [clientWs, clientData] of clients) {
    if (now - clientData.lastPing > CLIENT_STALE_MS && clientWs.readyState === clientWs.OPEN) {
      console.log(`[Client] Closing stale connection: ${clientData.id} (no ping in ${Math.round((now - clientData.lastPing) / 1000)}s)`);
      clientWs.close(4003, 'Stale connection');
      clients.delete(clientWs);
    }
  }
}, 30000);

// Check if any other client is watching a session (excludes given ws)
// Validate session is active and not dead (G4 — inject-race mitigation).
// Returns session data if valid, or null after sending error to client.
function validateActiveSession(ws, msg) {
  if (!msg.sessionId) return null;
  const sessionData = activeSessions.get(msg.sessionId);
  if (!sessionData || sessionData.failCount >= 3) {
    safeSend(ws, {
      type: 'error',
      message: 'Session unavailable',
      sessionId: msg.sessionId
    });
    return null;
  }
  return sessionData;
}

function isAnyoneWatching(sessionId, excludeWs = null) {
  for (const [ws, data] of clients) {
    if (ws !== excludeWs && data.watchingSessions.has(sessionId)) return true;
  }
  return false;
}

// Unwatch session if no other clients are watching
function maybeUnwatchSession(sessionId, excludeWs) {
  if (!isAnyoneWatching(sessionId, excludeWs)) {
    unwatchSession(sessionId);
  }
}

// Safe WebSocket send — absorbs throws from CLOSING/CLOSED sockets (CONS-002)
function safeSend(ws, payload) {
  try {
    ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
    return true;
  } catch (e) {
    console.error('[safeSend] ws.send failed:', e.message);
    return false;
  }
}

// Send pending prompts to a specific client (CONS-008 — single source of truth)
function sendPendingPrompts(ws, sessionId, sessionData) {
  if (!sessionData || sessionData.pendingPrompts.size === 0) return;
  safeSend(ws, {
    type: 'pending_prompts',
    sessionId,
    prompts: Array.from(sessionData.pendingPrompts.values()),
    lastSeq: sessionData.lastBroadcastSeq
  });
}

// ============================================
// WebSocket Handling
// ============================================

wss.on('connection', (ws, req) => {
  const clientId = Date.now().toString();
  let authenticated = false;
  let authFailures = 0;
  const MAX_AUTH_FAILURES = 3;

  // Per-connection rate limiting (60 messages/minute)
  const messageRateLimit = {
    timestamps: [],
    maxMessages: 60,
    windowMs: 60 * 1000,
    check() {
      const now = Date.now();
      this.timestamps = this.timestamps.filter(t => now - t < this.windowMs);
      if (this.timestamps.length >= this.maxMessages) return false;
      this.timestamps.push(now);
      return true;
    }
  };

  function initializeClient() {
    clients.set(ws, {
      id: clientId,
      connectedAt: Date.now(),
      lastPing: Date.now(),
      watchingSessions: new Set(),
      settings: {
        ttsEnabled: false,
        ttsVoice: 'default',
        speakToolCalls: false
      }
    });

    console.log(`[Client] Connected: ${clientId}`);

    // Send initial session list
    discoverSessions().then(sessions => {
      ws.send(JSON.stringify({
        type: 'sessions',
        data: sessions
      }));
    });

    // Send available slash commands
    discoverCommands(activeSessions).then(commands => {
      ws.send(JSON.stringify({
        type: 'commands',
        data: commands
      }));
    });
  }

  ws.on('message', (message) => {
    try {
      // Rate limit check
      if (!messageRateLimit.check()) {
        sendError(ws, ErrorCodes.RATE_LIMITED, 'Rate limit exceeded', { limit: 60, window: 'minute' });
        return;
      }

      const msg = JSON.parse(message);

      // Handle auth message (preferred method - token not in URL)
      if (msg.action === 'auth') {
        if (authenticated) {
          ws.send(JSON.stringify({ type: 'auth_result', success: true }));
          return;
        }
        if (secureCompare(msg.token, AUTH_TOKEN)) {
          authenticated = true;
          initializeClient();
          ws.send(JSON.stringify({ type: 'auth_result', success: true }));
        } else {
          authFailures++;
          ws.send(JSON.stringify({ type: 'auth_result', success: false, error: 'Invalid token' }));
          if (authFailures >= MAX_AUTH_FAILURES) {
            ws.close(4001, 'Too many failed auth attempts');
          }
        }
        return;
      }

      // Require authentication for all other messages
      if (!authenticated) {
        sendError(ws, ErrorCodes.UNAUTHORIZED, 'Not authenticated', { action: 'auth_required' });
        return;
      }

      handleClientMessage(ws, msg);
    } catch (e) {
      console.error('WebSocket message error:', e);
    }
  });

  ws.on('error', (err) => {
    console.error(`[Client] WebSocket error for ${clientId}:`, err.message);
  });

  ws.on('close', () => {
    const clientData = clients.get(ws);
    if (clientData) {
      clientData.watchingSessions.forEach(sessionId => {
        maybeUnwatchSession(sessionId, ws);
      });
    }

    clients.delete(ws);
    if (authenticated) {
      console.log(`[Client] Disconnected: ${clientId}`);
    }
  });
});

async function handleClientMessage(ws, msg) {
  const clientData = clients.get(ws);

  // Validate sessionId format when present
  if (msg.sessionId && typeof msg.sessionId === 'string') {
    // Session IDs are either UUIDs (from JSONL files) or tty-pid format (%N-PID on Linux).
    // '%' is safe here: session IDs are used as Map keys only, never interpolated into
    // shell commands or file paths (TTY paths come from the session object, not the ID).
    if (!/^([a-f0-9-]{8,}|%\d+(-\d+)?)$/.test(msg.sessionId) || msg.sessionId.length > 100) {
      sendError(ws, 'INVALID_SESSION_ID', 'Invalid session ID format');
      return;
    }
  }

  switch (msg.action) {
    case 'watch_session': {
      const session = await watchSession(msg.sessionId);
      if (session) {
        clientData.watchingSessions.add(msg.sessionId);
        // Pause broadcasting to this client until history is sent
        clientData.pauseBroadcast = true;
        try {
          const sessionData = activeSessions.get(msg.sessionId);
          ws.send(JSON.stringify({
            type: 'watching',
            sessionId: msg.sessionId,
            session: { ...session, mode: sessionData?.mode || 'default' }
          }));
          // Send current session status BEFORE history so recoverFromHistory
          // knows whether the session is waiting for user input
          const currentStatus = await getSessionStatus(session.logFile);
          if (sessionData) sessionData.lastStatus = currentStatus;
          ws.send(JSON.stringify({
            type: 'session_status',
            sessionId: msg.sessionId,
            status: currentStatus
          }));
          // Send full claudeState snapshot BEFORE history so the client's
          // allowedTools is populated before recoverFromHistory runs —
          // otherwise already-granted permissions reappear as stale prompts.
          const claudeState = buildClaudeState(msg.sessionId);
          if (claudeState) {
            ws.send(JSON.stringify({
              type: 'claude_state',
              sessionId: msg.sessionId,
              state: claudeState
            }));
          }
          // Send pending prompts immediately (authoritative prompt recovery)
          sendPendingPrompts(ws, msg.sessionId, sessionData);

          // If client provides fromSeq, send delta from recent events buffer
          // and skip full history — delta is sufficient for brief disconnects
          let deltaServed = false;
          if (msg.fromSeq != null && sessionData) {
            const fromSeq = Math.max(0, Math.floor(Number(msg.fromSeq)) || 0);
            if (fromSeq > 0 && fromSeq <= sessionData.lastBroadcastSeq) {
              const delta = sessionData.recentEvents.filter(e => e.seq > fromSeq);
              if (delta.length > 0) {
                safeSend(ws, {
                  type: 'session_delta',
                  sessionId: msg.sessionId,
                  events: delta,
                  lastSeq: sessionData.lastBroadcastSeq
                });
                deltaServed = true;
              }
            }
            // fromSeq too old (evicted from buffer) or invalid — fall through to full history
          }

          if (!deltaServed) {
            await sendRecentHistory(ws, msg.sessionId);
          }
          await sendActiveSubagents(ws, msg.sessionId);
          // Send current context percentage so the ring starts at the right value
          if (sessionData?.contextPercentage > 0) {
            ws.send(JSON.stringify({
              type: 'context_percentage',
              sessionId: msg.sessionId,
              percentage: sessionData.contextPercentage
            }));
          }
        } finally {
          // Resume broadcasting — live events will now flow after history
          clientData.pauseBroadcast = false;
        }
      } else {
        sendError(ws, ErrorCodes.SESSION_NOT_FOUND, 'Session ended or not found', { sessionId: msg.sessionId });
        // Proactively send updated session list so client can pick a new session
        const sessions = await discoverSessions();
        ws.send(JSON.stringify({ type: 'sessions', data: sessions }));
      }
      break;
    }
      
    case 'unwatch_session':
      clientData.watchingSessions.delete(msg.sessionId);
      maybeUnwatchSession(msg.sessionId, ws);
      break;
      
    case 'refresh_sessions':
      discoverSessions().then(sessions => {
        ws.send(JSON.stringify({
          type: 'sessions',
          data: sessions
        }));
      });
      break;

    case 'catch_up':
      // Send recent history when client returns from background
      if (msg.sessionId) {
        sendRecentHistory(ws, msg.sessionId).catch(err => {
          console.error('[catch_up] sendRecentHistory failed:', err.message);
        });
      }
      break;

    case 'inject': {
      const injectSessionData = validateActiveSession(ws, msg);
      if (msg.sessionId && !injectSessionData) break;
      // Validate command input
      if (typeof msg.command !== 'string' || msg.command.length === 0) {
        ws.send(JSON.stringify({ type: 'inject_result', success: false, error: 'Command required' }));
        break;
      }
      if (msg.command.length > 10000) {
        ws.send(JSON.stringify({ type: 'inject_result', success: false, error: 'Command too long (max 10000 chars)' }));
        break;
      }
      // Validate toolUseId if present — must be a string, max 200 chars, alphanumeric/dash/underscore
      if (msg.toolUseId !== undefined) {
        if (typeof msg.toolUseId !== 'string' || msg.toolUseId.length > 200 || !/^[a-zA-Z0-9_-]+$/.test(msg.toolUseId)) {
          console.log(`[Permission] Invalid toolUseId rejected: ${typeof msg.toolUseId} (${String(msg.toolUseId).substring(0, 50)})`);
          delete msg.toolUseId;
        }
      }
      // Track "always" grants — record which tool was just granted
      if (msg.command === 'always' && msg.sessionId) {
        const sd = activeSessions.get(msg.sessionId);
        if (sd) {
          let grantedTool = null;
          // Prefer toolUseId-based lookup (from iOS/updated web client)
          if (msg.toolUseId && sd.permissionToolMap.has(msg.toolUseId)) {
            grantedTool = sd.permissionToolMap.get(msg.toolUseId).tool;
            sd.permissionToolMap.delete(msg.toolUseId);
          }
          // Legacy fallback: no toolUseId — skip grant to avoid race condition.
          // Old web clients without toolUseId won't get server-side sessionGranted
          // tracking, but the local alwaysAllowedTools set in prompts.js still works.
          if (grantedTool) {
            sd.sessionGranted.add(grantedTool);
            console.log(`[Permission] Always-granted: ${grantedTool} (toolUseId: ${msg.toolUseId})`);
            broadcastClaudeState(msg.sessionId);
          } else if (!msg.toolUseId) {
            console.log(`[Permission] Always-grant skipped: no toolUseId provided (legacy client)`);
          } else {
            console.log(`[Permission] Always-grant skipped: toolUseId ${msg.toolUseId} not found in permissionToolMap`);
          }
        }
      }
      // Use cached session first (fast), fall back to discovery (slow) if needed
      (async () => {
        try {
          // Check cached activeSessions first
          let injectTty = activeSessions.get(msg.sessionId)?.session?.tty;

          // Fall back to discovery only if not in cache
          if (!injectTty && msg.sessionId) {
            const sessions = await discoverSessions();
            const found = sessions.find(s => s.id === msg.sessionId);
            injectTty = found?.tty;
          }

          if (injectTty) {
            try {
              await injectCommandToTty(msg.command, injectTty);
              ws.send(JSON.stringify({ type: 'inject_result', success: true }));
            } catch (err) {
              console.log(`[Inject] TTY injection failed, trying legacy: ${err.message}`);
              await injectCommandLegacy(msg.command);
              ws.send(JSON.stringify({ type: 'inject_result', success: true }));
            }
          } else {
            await injectCommandLegacy(msg.command);
            ws.send(JSON.stringify({ type: 'inject_result', success: true }));
          }

          // Post-answer prompt reconciliation: clear answered prompt, re-send remaining
          if (injectSessionData && msg.toolUseId) {
            injectSessionData.pendingPrompts.delete(msg.toolUseId);
          }
          sendPendingPrompts(ws, msg.sessionId, injectSessionData);
        } catch (err) {
          console.error(`[Inject] Failed: ${err.message}`);
          ws.send(JSON.stringify({ type: 'inject_result', success: false, code: ErrorCodes.INJECT_FAILED, error: 'Command injection failed' }));
        }
      })();
      break;
    }

    case 'select_option': {
      if (msg.sessionId && !validateActiveSession(ws, msg)) break;
      // Navigate an interactive selector (AskUserQuestion) by sending arrow-down
      // keystrokes to reach the correct option index, then Enter to confirm.
      // Claude Code's ink-based selector ignores typed text — only arrow keys work.
      const optionIndex = parseInt(msg.index, 10);
      if (isNaN(optionIndex) || optionIndex < 0 || optionIndex > 20) {
        ws.send(JSON.stringify({ type: 'inject_result', success: false, error: 'Invalid option index' }));
        break;
      }
      (async () => {
        try {
          let selectTty = activeSessions.get(msg.sessionId)?.session?.tty;
          if (!selectTty && msg.sessionId) {
            const sessions = await discoverSessions();
            const found = sessions.find(s => s.id === msg.sessionId);
            selectTty = found?.tty;
          }

          if (selectTty) {
            await selectOptionInTty(optionIndex, selectTty);
            ws.send(JSON.stringify({ type: 'inject_result', success: true }));
          } else {
            ws.send(JSON.stringify({ type: 'inject_result', success: false, error: 'Session TTY not found' }));
          }
        } catch (err) {
          console.error(`[SelectOption] Failed: ${err.message}`);
          ws.send(JSON.stringify({ type: 'inject_result', success: false, code: ErrorCodes.INJECT_FAILED, error: err.message }));
        }
      })();
      break;
    }

    case 'select_other': {
      // Combined action: select the "Other" option in an ink Select, then inject
      // freeform text. This avoids the race condition of separate select_option +
      // inject messages where the inject can arrive before ink transitions to TextInput.
      const otherIndex = parseInt(msg.index, 10);
      const otherText = msg.text;
      if (isNaN(otherIndex) || otherIndex < 0 || otherIndex > 20) {
        ws.send(JSON.stringify({ type: 'inject_result', success: false, error: 'Invalid option index' }));
        break;
      }
      if (typeof otherText !== 'string' || otherText.length === 0) {
        ws.send(JSON.stringify({ type: 'inject_result', success: false, error: 'Text required' }));
        break;
      }
      if (otherText.length > 10000) {
        ws.send(JSON.stringify({ type: 'inject_result', success: false, error: 'Text too long (max 10000 chars)' }));
        break;
      }
      (async () => {
        try {
          let otherTty = activeSessions.get(msg.sessionId)?.session?.tty;
          if (!otherTty && msg.sessionId) {
            const sessions = await discoverSessions();
            const found = sessions.find(s => s.id === msg.sessionId);
            otherTty = found?.tty;
          }

          if (otherTty) {
            // Step 1: Navigate to "Other" and press Enter
            await selectOptionInTty(otherIndex, otherTty);
            // Step 2: Wait for ink to transition from Select to TextInput
            await new Promise(r => setTimeout(r, 600));
            // Step 3: Inject the freeform text
            await injectCommandToTty(otherText, otherTty);
            ws.send(JSON.stringify({ type: 'inject_result', success: true }));
          } else {
            ws.send(JSON.stringify({ type: 'inject_result', success: false, error: 'Session TTY not found' }));
          }
        } catch (err) {
          console.error(`[SelectOther] Failed: ${err.message}`);
          ws.send(JSON.stringify({ type: 'inject_result', success: false, code: ErrorCodes.INJECT_FAILED, error: err.message }));
        }
      })();
      break;
    }

    case 'escape': {
      if (msg.sessionId && !validateActiveSession(ws, msg)) break;
      // Use cached session first (fast), fall back to discovery (slow) if needed
      (async () => {
        try {
          let escapeTty = activeSessions.get(msg.sessionId)?.session?.tty;

          if (!escapeTty && msg.sessionId) {
            const sessions = await discoverSessions();
            const found = sessions.find(s => s.id === msg.sessionId);
            escapeTty = found?.tty;
          }

          if (escapeTty) {
            try {
              await sendEscapeKeyToTty(escapeTty);
              ws.send(JSON.stringify({ type: 'escape_result', success: true }));
            } catch (err) {
              await sendEscapeKeyLegacy();
              ws.send(JSON.stringify({ type: 'escape_result', success: true }));
            }
          } else {
            await sendEscapeKeyLegacy();
            ws.send(JSON.stringify({ type: 'escape_result', success: true }));
          }
        } catch (err) {
          console.error(`[Escape] Failed: ${err.message}`);
          ws.send(JSON.stringify({ type: 'escape_result', success: false, error: err.message }));
        }
      })();
      break;
    }

    case 'clear_and_resume': {
      const sessionId = msg.sessionId;
      const sd = activeSessions.get(sessionId);
      if (!sd) {
        sendError(ws, ErrorCodes.SESSION_NOT_FOUND, 'Session not found', { sessionId });
        break;
      }
      if (sd.pendingClear) {
        ws.send(JSON.stringify({
          type: 'clear_and_resume_progress',
          sessionId,
          step: 'already_pending',
          message: 'Clear already in progress'
        }));
        break;
      }

      const logsDir = path.dirname(sd.session.logFile);
      const cwd = sd.session.cwd;
      const tty = sd.session.tty;
      sd.pendingClear = {
        startedAt: Date.now(),
        cwd,
        tty,
        logsDir,
        oldLogFile: sd.session.logFile
      };

      // Step 1: Save state before clearing
      broadcastToClients({
        type: 'clear_and_resume_progress',
        sessionId,
        step: 'saving_state',
        message: 'Saving session state...'
      });

      (async () => {
        try {
          // Record initial .compact-state.md mtime (or 0 if non-existent)
          const stateFilePath = path.join(cwd, '.compact-state.md');
          let initialMtime = 0;
          try {
            const stats = await fsp.stat(stateFilePath);
            initialMtime = stats.mtimeMs;
          } catch { /* file doesn't exist yet */ }

          // Write detailed save instructions to a temp file so the injected command stays short
          const instructionsPath = path.join(cwd, '.claude-save-instructions.tmp');
          const saveInstructions = [
            'Write a handoff document to .compact-state.md in the project root.',
            'A fresh Claude session with ZERO prior context will read ONLY this file to continue your work.',
            'Its effectiveness depends entirely on what you write here.',
            '',
            'Use these exact sections:',
            '',
            '# Session State',
            '',
            '## Objective',
            'The user\'s original request and what we are trying to accomplish.',
            '',
            '## Branch & Git State',
            'Current branch name. Run `git diff --stat` and `git log --oneline -5` to capture actual state.',
            '',
            '## Completed',
            'What is done. Use `file:line` references for changes, NOT code blocks.',
            '',
            '## In Progress',
            'What is partially done. Describe exactly where you stopped and what remains.',
            '',
            '## Key Decisions',
            'Decisions made and WHY (rationale). The next agent must not re-debate these.',
            '',
            '## Failed Approaches',
            'What was tried and abandoned, with reasons. Prevent the next agent from repeating mistakes.',
            '',
            '## Blockers & Open Questions',
            'Unresolved issues or questions needing user input.',
            '',
            '## Next Steps (Ordered)',
            'Numbered list of exactly what to do next, in priority order.',
            '',
            '## Important Context',
            'Architecture constraints, patterns, non-obvious facts the next agent needs.',
            '',
            'Write the file NOW. Do not ask questions. Do not summarize what you will do. Just write it.',
            'When done, delete .claude-save-instructions.tmp.',
          ].join('\n');
          await fsp.writeFile(instructionsPath, saveInstructions);

          // Prepare session: Escape (cancel processing) + Ctrl+U (clear input)
          await prepareSessionForInjection(tty);

          // Inject a SHORT command that references the instructions file
          await injectCommandToTty('Read .claude-save-instructions.tmp and follow those instructions exactly.', tty);
          console.log(`[Clear&Resume] Save-state prompt injected for session ${sessionId.substring(0, 8)}`);

          // Poll until Claude finishes saving state
          // Note: during multi-tool responses, getSessionStatus() oscillates between
          // 'processing', 'waiting', and 'active'. We require multiple consecutive
          // non-processing polls to confirm Claude is truly done (not just between tool calls).
          const maxWaitMs = 90000;
          const pollMs = 2000;
          const startTime = Date.now();
          let savedState = false;
          let sawProcessing = false;
          let nonProcessingCount = 0;
          const requiredStablePollCount = 3; // 3 consecutive polls = 6s of non-processing

          while (Date.now() - startTime < maxWaitMs) {
            await new Promise(r => setTimeout(r, pollMs));

            // Check if pendingClear was cancelled externally
            const currentSd = activeSessions.get(sessionId);
            if (!currentSd || !currentSd.pendingClear) return;

            // Check if .compact-state.md was modified
            let fileUpdated = false;
            try {
              const stats = await fsp.stat(stateFilePath);
              if (stats.mtimeMs > initialMtime) {
                fileUpdated = true;
              }
            } catch { /* file still doesn't exist */ }

            // Check session status
            const status = await getSessionStatus(currentSd.session.logFile);
            if (status === 'processing') {
              sawProcessing = true;
              nonProcessingCount = 0;
            } else if (sawProcessing) {
              nonProcessingCount++;
              // Require consecutive non-processing polls to confirm Claude finished
              // (status oscillates during multi-tool responses)
              if (nonProcessingCount >= requiredStablePollCount) {
                savedState = fileUpdated;
                break;
              }
            } else if (fileUpdated) {
              // File was updated and Claude never entered processing — done
              savedState = true;
              break;
            }
          }

          // Clean up instructions file
          try { await fsp.unlink(instructionsPath); } catch { /* already deleted by Claude or missing */ }

          if (savedState) {
            console.log(`[Clear&Resume] State saved to .compact-state.md`);
          } else {
            console.warn(`[Clear&Resume] State save may not have completed, proceeding with /clear anyway`);
          }

          // Step 2: Prepare session again (clear any leftover input) then send /clear
          await prepareSessionForInjection(tty);

          broadcastToClients({
            type: 'clear_and_resume_progress',
            sessionId,
            step: 'clearing',
            message: 'Sending /clear...'
          });

          await injectCommandToTty('/clear', tty);
          console.log(`[Clear&Resume] /clear injected for session ${sessionId.substring(0, 8)}`);

          // Start 2s polling fallback (in case logsDirWatcher misses the new file)
          const pollInterval = setInterval(() => {
            checkForNewSessionAfterClear(sessionId);
          }, 2000);
          sd.pendingClear.pollInterval = pollInterval;

          // 30s timeout — fail gracefully if new session never appears
          const timeout = setTimeout(() => {
            const currentSd = activeSessions.get(sessionId);
            if (currentSd && currentSd.pendingClear) {
              clearInterval(currentSd.pendingClear.pollInterval);
              currentSd.pendingClear = null;
              console.warn(`[Clear&Resume] Timeout waiting for new session after /clear`);
              broadcastToClients({
                type: 'clear_and_resume_progress',
                sessionId,
                step: 'failed',
                message: 'Timeout: new session not detected after /clear'
              });
            }
          }, 30000);
          sd.pendingClear.timeout = timeout;
        } catch (err) {
          console.error(`[Clear&Resume] Failed: ${err.message}`);
          sd.pendingClear = null;
          broadcastToClients({
            type: 'clear_and_resume_progress',
            sessionId,
            step: 'failed',
            message: `Failed: ${err.message}`
          });
        }
      })();
      break;
    }

    case 'mode_toggle':
      // Send Shift+Tab to cycle modes (requires activating iTerm)
      (async () => {
        try {
          await sendModeToggle();
          ws.send(JSON.stringify({ type: 'mode_toggle_result', success: true }));
        } catch (err) {
          console.error(`[Mode Toggle] Failed: ${err.message}`);
          ws.send(JSON.stringify({ type: 'mode_toggle_result', success: false, error: err.message }));
        }
      })();
      break;

    case 'update_settings':
      Object.assign(clientData.settings, msg.settings);
      break;

    case 'ping': {
      const cd = clients.get(ws);
      if (cd) cd.lastPing = Date.now();
      ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      break;
    }

    case 'get_state':
      ws.send(JSON.stringify({
        type: 'state',
        clientId: clientData.id,
        watchingSessions: Array.from(clientData.watchingSessions),
        settings: clientData.settings,
        connectedAt: clientData.connectedAt
      }));
      break;
  }
}

const HISTORY_READ_SIZE = 200 * 1024; // Read last 200KB for history (not entire file)

async function sendRecentHistory(ws, sessionId) {
  const sessionData = activeSessions.get(sessionId);
  if (!sessionData || !sessionData.session.logFile) return;

  try {
    // Check if file exists using async access
    try {
      await fsp.access(sessionData.session.logFile);
    } catch {
      ws.send(JSON.stringify({ type: 'history', sessionId, data: [] }));
      return;
    }

    const stats = await fsp.stat(sessionData.session.logFile);
    let content;

    if (stats.size <= HISTORY_READ_SIZE) {
      // Small file - read entirely
      content = await fsp.readFile(sessionData.session.logFile, 'utf8');
    } else {
      // Large file - read only last HISTORY_READ_SIZE bytes
      const fh = await fsp.open(sessionData.session.logFile, 'r');
      const buffer = Buffer.alloc(HISTORY_READ_SIZE);
      await fh.read(buffer, 0, HISTORY_READ_SIZE, stats.size - HISTORY_READ_SIZE);
      await fh.close();
      content = buffer.toString('utf8');

      // Skip first partial line (may be incomplete)
      const firstNewline = content.indexOf('\n');
      if (firstNewline > 0) {
        content = content.slice(firstNewline + 1);
      }
    }

    const lines = content.split('\n').filter(line => line.trim());

    // Calculate context percentage from the last assistant message's token usage.
    // Scan backwards through lines to find the most recent usage data.
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === 'assistant' && entry.message?.usage) {
          const pct = calculateContextPercentage(entry.message.usage, entry.message.model);
          if (pct !== null && sessionData) {
            sessionData.contextPercentage = pct;
            if (entry.message.model) sessionData.model = entry.message.model;
          }
          break;
        }
      } catch (e) { /* skip unparseable lines */ }
    }

    // Scan lines BEFORE the history window for task state and milestones —
    // tasks/milestones created early in the session may be outside the
    // HISTORY_LINE_LIMIT display window.
    // parseLogEntry accumulates task_create/task_update into sessionData.tasks.
    const recentLines = lines.slice(-HISTORY_LINE_LIMIT);
    if (sessionData && lines.length > HISTORY_LINE_LIMIT) {
      sessionData.tasks.clear();
      sessionData.milestones = [];
      sessionData.toolBurstCount = 0;
      const olderLines = lines.slice(0, -HISTORY_LINE_LIMIT);
      for (const line of olderLines) {
        try {
          const entry = JSON.parse(line);
          if (entry.type === 'user' && entry.toolUseResult?.agentId) continue;
          const parsed = parseLogEntry(entry, sessionData, parserState);
          if (parsed) {
            const items = Array.isArray(parsed) ? parsed : [parsed];
            for (const item of items) {
              detectMilestone(item, sessionData);
            }
          }
        } catch (e) {
          // Skip invalid JSON
        }
      }
    }

    const allItems = [];
    let lastMode = null;

    for (const line of recentLines) {
      try {
        const entry = JSON.parse(line);

        // Track the last permissionMode from user entries for initial mode state
        if (entry.type === 'user' && entry.permissionMode) {
          lastMode = entry.permissionMode;
        }

        // parseLogEntry already skips Task results (via agentId check),
        // but skip here too for efficiency
        if (entry.type === 'user' && entry.toolUseResult?.agentId) {
          continue;
        }

        const parsed = parseLogEntry(entry, sessionData, parserState);
        if (parsed) {
          const items = Array.isArray(parsed) ? parsed : [parsed];
          allItems.push(...items.filter(i =>
            i.type !== 'token_usage' && i.type !== 'mode_change' &&
            i.type !== 'task_create' && i.type !== 'task_update' && i.type !== 'task_list' &&
            i.type !== 'status_update' && i.type !== 'subagent_starting' &&
            i.type !== 'compaction_starting' && i.type !== 'team_create' &&
            i.type !== 'team_delete' && i.type !== 'permission_resolved'
          ));
        }
      } catch (e) {
        // Skip invalid JSON lines in history (expected for partial writes)
      }
    }

    // Auto-approved permission_requests → convert to 'tool' (same logic as live messages)
    const resolvedToolUseIds = new Set(
      allItems
        .filter(i => i.type === 'tool_result' && i.toolUseId)
        .map(i => i.toolUseId)
    );
    const history = allItems.map(item => {
      if (item.type === 'permission_request' && item.toolUseId && resolvedToolUseIds.has(item.toolUseId)) {
        return { ...item, type: 'tool' };
      }
      return item;
    });

    // Extract milestones from the history window items
    // (milestones from older lines were already extracted above)
    if (sessionData) {
      extractMilestones(history, sessionData);
    }

    // Set initial mode from history and notify the client
    // sessionData already declared at top of function
    if (lastMode && sessionData) {
      sessionData.mode = lastMode;
      console.log(`[Mode] Session ${sessionId.substring(0, 8)} initial mode from history: ${lastMode}`);
    }

    console.log(`[HISTORY] Sending ${history.length} items for session ${sessionId.substring(0, 8)}`);
    ws.send(JSON.stringify({ type: 'history', sessionId, data: history }));

    // Send accumulated task state after history so client has the full task list
    if (sessionData?.tasks?.size > 0) {
      const tasks = Array.from(sessionData.tasks.values());
      console.log(`[HISTORY] Sending ${tasks.length} accumulated tasks for session ${sessionId.substring(0, 8)}`);
      ws.send(JSON.stringify({ type: 'task_list', sessionId, tasks }));
    }

    // Send accumulated milestones after tasks
    if (sessionData?.milestones?.length > 0) {
      console.log(`[HISTORY] Sending ${sessionData.milestones.length} milestones for session ${sessionId.substring(0, 8)}`);
      ws.send(JSON.stringify({
        type: 'session_milestones',
        sessionId,
        milestones: sessionData.milestones
      }));
    }

    // Send current mode after history so client knows the session's mode
    const currentMode = sessionData?.mode || 'default';
    ws.send(JSON.stringify({ type: 'mode_change', sessionId, mode: currentMode }));
  } catch (e) {
    console.error('Error reading history:', e);
    ws.send(JSON.stringify({ type: 'history', sessionId, data: [], error: 'Failed to read history' }));
  }
}

async function sendActiveSubagents(ws, sessionId) {
  const sessionData = activeSessions.get(sessionId);
  if (!sessionData || !sessionData.subagentInfo || sessionData.subagentInfo.size === 0) return;

  const logsDir = path.dirname(sessionData.session.logFile);
  const subagentsDir = path.join(logsDir, sessionId, 'subagents');

  // Send subagent_start and recent output for each active subagent
  for (const [agentId, info] of sessionData.subagentInfo) {
    // Send start event
    ws.send(JSON.stringify({
      type: 'subagent_start',
      sessionId,
      agentId,
      description: info.description,
      agentType: info.agentType,
      timestamp: info.startTime
    }));

    // Read and send recent subagent output (excluding permission_requests —
    // subagent permissions are auto-approved server-side, never shown to user)
    try {
      const logFile = path.join(subagentsDir, `agent-${agentId}.jsonl`);
      const content = await fsp.readFile(logFile, 'utf8');
      const lines = content.split('\n').filter(l => l.trim());

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          const parsed = parseLogEntry(entry, activeSessions.get(sessionId), parserState);
          if (parsed) {
            const items = Array.isArray(parsed) ? parsed : [parsed];
            for (const item of items) {
              // Skip permission_request — auto-approved server-side
              if (item.type === 'permission_request') continue;
              // Skip permission_resolved — no card to dismiss
              if (item.type === 'permission_resolved') continue;
              // Send as subagent_output so client displays it
              ws.send(JSON.stringify({
                type: 'subagent_output',
                sessionId,
                agentId,
                data: item
              }));
            }
          }
        } catch (e) {
          // Skip invalid JSON
        }
      }
    } catch (e) {
      // Log file may not exist or be readable
      console.log(`[Subagent ${agentId}] Could not read log file for replay: ${e.message}`);
    }

    // Send accumulated tokens
    if (info.inputTokens > 0 || info.outputTokens > 0) {
      ws.send(JSON.stringify({
        type: 'subagent_tokens',
        sessionId,
        agentId,
        input: info.inputTokens,
        output: info.outputTokens
      }));
    }

    // Send current tool if any
    if (info.currentTool) {
      ws.send(JSON.stringify({
        type: 'subagent_tool',
        sessionId,
        agentId,
        tool: info.currentTool,
        input: {}
      }));
    }
  }

  console.log(`[Session ${sessionId.substring(0, 8)}] Sent ${sessionData.subagentInfo.size} active subagents with output to client`);
}

// File Browsing API (mounted as router)
app.use(createFileApiRouter({
  activeSessions, discoverSessions, secureCompare, AUTH_TOKEN, MAX_READ_SIZE
}));

// Basic health check - no sensitive info
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Detailed health requires authentication
app.get('/health/detailed', async (req, res) => {
  const auth = req.headers.authorization;
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!secureCompare(token, AUTH_TOKEN)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const sessions = await discoverSessions();
  res.json({
    status: 'ok',
    sessions: sessions.length,
    clients: clients.size
  });
});

// ============================================
// Graceful Shutdown
// ============================================

function shutdown() {
  console.log('\nShutting down...');

  // Close all sessions cleanly (watchers, subagents, poll intervals, timeouts)
  const sessionIds = Array.from(activeSessions.keys());
  for (const sessionId of sessionIds) {
    unwatchSession(sessionId);
  }

  // Notify and close all WebSocket clients
  clients.forEach((data, ws) => {
    try {
      ws.close(1001, 'Server shutdown');
    } catch (e) {
      // Ignore errors during shutdown
    }
  });
  clients.clear();

  // Close the HTTP server
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });

  // Force exit if graceful shutdown takes too long
  setTimeout(() => {
    console.error('Forced shutdown after timeout');
    process.exit(1);
  }, 5000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// ============================================
// Start Server
// ============================================

server.listen(PORT, async () => {
  const sessions = await discoverSessions();
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║         Claude Code Remote Access                             ║
╠═══════════════════════════════════════════════════════════════╣
║  URL:        http://localhost:${PORT}                           ║
║  WebSocket:  ws://localhost:${PORT}                             ║
║  Token:      ••••••••••••••••                                  ║
╠═══════════════════════════════════════════════════════════════╣
║  Features:                                                    ║
║    ✓ Real-time output streaming                               ║
║    ✓ Multi-session support                                    ║
║    ✓ Text-to-speech                                           ║
║    ✓ Voice input                                              ║
║    ✓ Push notifications                                       ║
╠═══════════════════════════════════════════════════════════════╣
║  Active Sessions: ${sessions.length.toString().padEnd(43)}║
${sessions.slice(0, 3).map(s => `║    • ${s.name.substring(0, 50).padEnd(53)}║`).join('\n')}
╚═══════════════════════════════════════════════════════════════╝
  `);
});
