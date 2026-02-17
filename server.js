const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises; // Async file operations
const http = require('http');
const WebSocket = require('ws');
const os = require('os');
const chokidar = require('chokidar');
const crypto = require('crypto');
const { parseTaskListResult } = require('./lib/parsers');

const app = express();
const PORT = process.env.PORT || 3456;
const AUTH_TOKEN = process.env.AUTH_TOKEN;
if (!AUTH_TOKEN || AUTH_TOKEN.length < 32) {
  console.error('ERROR: Set AUTH_TOKEN environment variable (minimum 32 characters)');
  console.error('Generate one with: openssl rand -hex 32');
  process.exit(1);
}
const MAX_READ_SIZE = 1024 * 1024; // 1MB max per read
const HISTORY_LINE_LIMIT = 100; // Max history lines to send on session load

// Claude Code spinner verbs (from tengu_spinner_words)
// These are the 90 verbs Claude Code randomly displays while processing
const SPINNER_VERBS = [
  'Accomplishing', 'Actioning', 'Actualizing', 'Baking', 'Booping', 'Brewing',
  'Calculating', 'Cerebrating', 'Channelling', 'Churning', 'Clauding', 'Coalescing',
  'Cogitating', 'Combobulating', 'Computing', 'Concocting', 'Conjuring', 'Considering',
  'Contemplating', 'Cooking', 'Crafting', 'Creating', 'Crunching', 'Deciphering',
  'Deliberating', 'Determining', 'Discombobulating', 'Divining', 'Doing', 'Effecting',
  'Elucidating', 'Enchanting', 'Envisioning', 'Finagling', 'Flibbertigibbeting', 'Forging',
  'Forming', 'Frolicking', 'Generating', 'Germinating', 'Hatching', 'Herding', 'Honking',
  'Hustling', 'Ideating', 'Imagining', 'Incubating', 'Inferring', 'Jiving', 'Manifesting',
  'Marinating', 'Meandering', 'Moseying', 'Mulling', 'Mustering', 'Musing', 'Noodling',
  'Percolating', 'Perusing', 'Philosophising', 'Pondering', 'Pontificating', 'Processing',
  'Puttering', 'Puzzling', 'Reticulating', 'Ruminating', 'Scheming', 'Schlepping', 'Shimmying',
  'Shucking', 'Simmering', 'Smooshing', 'Spelunking', 'Spinning', 'Stewing', 'Sussing',
  'Synthesizing', 'Thinking', 'Tinkering', 'Transmuting', 'Unfurling', 'Unravelling', 'Vibing',
  'Wandering', 'Whirring', 'Wibbling', 'Wizarding', 'Working', 'Wrangling'
];

function getRandomSpinnerVerb() {
  return SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)];
}

// Track pending subagent descriptions for correlation with subagent IDs
const pendingSubagentDescriptions = new Map(); // timestamp -> { description, type }

// Throttle subagent_tool messages to prevent flooding iOS with re-renders
const subagentToolThrottles = new Map(); // agentId → lastSentTimestamp
const SUBAGENT_TOOL_THROTTLE_MS = 500;

// Map pending task IDs to real task IDs assigned by Claude Code
const pendingTaskIds = new Map();  // tool_use_id → pendingId
const taskIdMap = new Map();       // realId → pendingId

// Strip ANSI escape codes from strings (tool output often contains terminal colors)
// Covers CSI sequences (\x1b[...X), OSC sequences (\x1b]...BEL/ST), and charset selection (\x1b(X)
function stripAnsi(str) {
  return str.replace(/\x1b(?:\[[0-9;]*[a-zA-Z]|\].*?(?:\x07|\x1b\\)|\([A-B])/g, '');
}

// Format MCP tool names for readability
// mcp__github__create_issue -> GitHub: create_issue
function formatMcpToolName(name) {
  const parts = name.split('__');
  if (parts.length >= 3) {
    const server = parts[1].charAt(0).toUpperCase() + parts[1].slice(1);
    return `${server}: ${parts.slice(2).join('_')}`;
  }
  return name;
}

// Redact sensitive fields from MCP tool inputs
function sanitizeMcpInput(input) {
  if (!input) return {};
  const safe = { ...input };
  const sensitiveKeys = ['password', 'token', 'secret', 'key', 'auth', 'credential'];
  for (const key of Object.keys(safe)) {
    if (sensitiveKeys.some(s => key.toLowerCase().includes(s))) {
      safe[key] = '[REDACTED]';
    }
  }
  return safe;
}

// Structured error codes for agent-friendly error handling
const ErrorCodes = {
  RATE_LIMITED: 'RATE_LIMITED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  INJECT_FAILED: 'INJECT_FAILED'
};

function sendError(ws, code, message, details = {}) {
  ws.send(JSON.stringify({
    type: 'error',
    code,
    message,
    details
  }));
}

// Timing-safe token comparison to prevent timing attacks
function secureCompare(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

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

// Claude projects directory
const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects');

// ============================================
// Session Discovery & Watching
// ============================================

// Get active Claude processes with their terminal info
function getActiveClaude() {
  return new Promise((resolve) => {
    // Get Claude processes with TTYs
    exec('ps -eo pid,tty,command | grep "ttys.*claude" | grep -v grep', (err, stdout) => {
      if (err || !stdout.trim()) {
        resolve([]);
        return;
      }

      const processes = [];
      stdout.trim().split('\n').forEach(line => {
        const match = line.trim().match(/^(\d+)\s+(ttys\d+)\s+(.*)$/);
        if (match && match[3].match(/^claude(\s|$)/)) {
          processes.push({ pid: match[1], tty: match[2] });
        }
      });

      if (processes.length === 0) {
        resolve([]);
        return;
      }

      // Batch all PIDs in single lsof call (performance: O(1) instead of O(N))
      const pids = processes.map(p => p.pid).join(',');
      exec(`lsof -a -p ${pids} -d cwd 2>/dev/null`, (err2, lsofOutput) => {
        if (err2 || !lsofOutput) {
          resolve([]);
          return;
        }

        // Parse lsof output to map PID -> cwd
        const pidToCwd = {};
        lsofOutput.split('\n').forEach(line => {
          // lsof format: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 9 && parts[3] === 'cwd') {
            const pid = parts[1];
            const cwd = parts[parts.length - 1]; // NAME is last field
            pidToCwd[pid] = cwd;
          }
        });

        // Build results with cwd from batched lookup
        const results = processes
          .filter(proc => pidToCwd[proc.pid])
          .map(proc => ({
            pid: proc.pid,
            tty: proc.tty,
            cwd: pidToCwd[proc.pid]
          }));

        resolve(results);
      });
    });
  });
}

// Get git branch for a directory (returns null if not a git repo)
function getGitBranch(cwd) {
  return new Promise((resolve) => {
    exec('git rev-parse --abbrev-ref HEAD', { cwd }, (err, stdout) => {
      if (err || !stdout.trim()) {
        resolve(null);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

// Load allowed tools from Claude Code's settings files
async function loadAllowedTools(sessionCwd) {
  // Tools that Claude Code never prompts the user for in any permission mode.
  // Read-only tools (Read, Glob, Grep, WebSearch, WebFetch) never prompt — they
  // either succeed or Claude refuses internally. Agent management tools (Task,
  // SendMessage, TeamCreate) also never prompt. Only Bash, Edit, Write, and
  // NotebookEdit actually block the terminal waiting for user permission.
  const allowed = new Set([
    // Internal / meta tools
    'TodoRead', 'TodoWrite',
    'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList',
    'EnterPlanMode', 'ExitPlanMode',
    'Skill', 'NotebookRead',
    // Read-only tools — never prompt in any mode
    'Read', 'Glob', 'Grep',
    'WebSearch', 'WebFetch',
    // Agent management — never prompt
    'Task', 'TaskOutput', 'TaskStop',
    'AskUserQuestion',
    'SendMessage', 'TeamCreate', 'TeamDelete',
  ]);

  const claudeHome = path.join(os.homedir(), '.claude');

  // User-level: ~/.claude/settings.local.json
  try {
    const raw = await fsp.readFile(path.join(claudeHome, 'settings.local.json'), 'utf8');
    const settings = JSON.parse(raw);
    (settings.permissions?.allow || []).forEach(t => allowed.add(t));
  } catch { /* no user settings */ }

  // Project-level: ~/.claude/projects/<hash>/settings.local.json
  if (sessionCwd) {
    const projectHash = sessionCwd.replace(/[/_]/g, '-');
    try {
      const raw = await fsp.readFile(path.join(claudeHome, 'projects', projectHash, 'settings.local.json'), 'utf8');
      const settings = JSON.parse(raw);
      (settings.permissions?.allow || []).forEach(t => allowed.add(t));
    } catch { /* no project settings */ }
  }

  return allowed;
}

// Check if a tool needs user permission (not pre-allowed)
function needsPermission(toolName, sessionData) {
  if (!sessionData) return true;
  const allowed = sessionData.allowedTools || new Set();
  const granted = sessionData.sessionGranted || new Set();

  // Exact match only — domain-scoped grants like WebFetch(domain:x.com)
  // are handled by Claude Code internally. If Claude Code auto-approves,
  // the batch filter (permission_request + tool_result in same batch)
  // suppresses the prompt. If Claude Code blocks, the prompt shows.
  if (allowed.has(toolName) || granted.has(toolName)) return false;

  // MCP tools: already checked by exact match above
  return true;
}

async function discoverSessions() {
  const sessions = [];

  // Get active Claude processes
  const activeProcesses = await getActiveClaude();

  if (activeProcesses.length === 0) {
    return sessions;
  }

  // Build cwd -> project data map (check all project dirs)
  const cwdToProject = {};
  try {
    await fsp.access(CLAUDE_DIR);
    const projectDirs = await fsp.readdir(CLAUDE_DIR);
    for (const projectHash of projectDirs) {
      const projectDir = path.join(CLAUDE_DIR, projectHash);
      // Always scan JSONL files directly - sessions-index.json can be stale after `claude resume`
      try {
        const files = await fsp.readdir(projectDir);
        const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));

        for (const jsonlFile of jsonlFiles) {
          const fullPath = path.join(projectDir, jsonlFile);
          const sessionId = path.basename(jsonlFile, '.jsonl');
          const stats = await fsp.stat(fullPath);

          // Read first 2KB to find cwd field
          const fh = await fsp.open(fullPath, 'r');
          const buffer = Buffer.alloc(2000);
          try {
            await fh.read(buffer, 0, 2000, 0);
          } finally {
            await fh.close();
          }

          const content = buffer.toString('utf8');
          const cwdMatch = content.match(/"cwd":"([^"]+)"/);

          if (cwdMatch) {
            const cwd = cwdMatch[1];
            if (!cwdToProject[cwd]) {
              cwdToProject[cwd] = { projectHash, indexData: { originalPath: cwd, entries: [] } };
            }
            cwdToProject[cwd].indexData.entries.push({
              sessionId,
              fullPath,
              fileMtime: stats.mtime.getTime(),
              modified: stats.mtime.toISOString()
            });
          }
        }
      } catch (e) {
        // File read error during session discovery (non-fatal)
        console.debug(`[Discovery] Error reading project dir ${projectDir}: ${e.message}`);
      }
    }
  } catch {
    // CLAUDE_DIR doesn't exist yet - no sessions
  }

  // Track assigned session IDs to avoid duplicates when multiple processes share cwd
  const assignedSessionIds = new Set();

  // For each active Claude process, create an entry
  for (const proc of activeProcesses) {
    // Use directory name as stable identifier (Claude overwrites iTerm tab titles)
    const dirName = path.basename(proc.cwd) || `Session ${proc.tty}`;
    const project = cwdToProject[proc.cwd];

    // Get git branch (runs in parallel with file checks below)
    const branchPromise = getGitBranch(proc.cwd);

    // Find session file if project exists
    let logFile = null;
    let sessionId = `${proc.tty}-${proc.pid}`; // Fallback ID based on process
    let status = 'unknown';
    let lastActive = new Date().toISOString();

    if (project) {
      // Filter for existing files (async)
      const allEntries = project.indexData.entries || [];
      const existChecks = await Promise.all(
        allEntries.map(async e => {
          try {
            await fsp.access(e.fullPath);
            return true;
          } catch {
            return false;
          }
        })
      );
      const entries = allEntries
        .filter((_, i) => existChecks[i])
        .sort((a, b) => new Date(b.modified || b.fileMtime) - new Date(a.modified || a.fileMtime));

      if (entries.length > 0) {
        // Find first unassigned session (handles multiple processes in same cwd)
        const entry = entries.find(e => !assignedSessionIds.has(e.sessionId));
        if (entry) {
          logFile = entry.fullPath;
          sessionId = entry.sessionId;
          assignedSessionIds.add(sessionId);
          status = await getSessionStatus(entry.fullPath);
          lastActive = entry.modified || new Date(entry.fileMtime).toISOString();
        }
      }
    }

    const branch = await branchPromise;

    sessions.push({
      id: sessionId,
      name: dirName,
      status: status,
      cwd: proc.cwd,
      branch: branch,
      lastActive: lastActive,
      logFile: logFile,
      tty: proc.tty,
      pid: proc.pid
    });
  }

  // Sort by tab name, then by sessionId for stable ordering when names match
  sessions.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

  return sessions;
}

async function watchSession(sessionId) {
  // If already watching, return existing watcher (avoid redundant discoverSessions call)
  if (activeSessions.has(sessionId)) {
    return activeSessions.get(sessionId).session;
  }

  const sessions = await discoverSessions();
  const session = sessions.find(s => s.id === sessionId);

  if (!session || !session.logFile) {
    return null;
  }
  
  // Track file position to only read new content
  let lastPosition = 0;
  try {
    const stats = await fsp.stat(session.logFile);
    lastPosition = stats.size;
  } catch (e) {
    // File might not exist yet
  }
  
  // Watch the log file for changes
  const watcher = chokidar.watch(session.logFile, {
    persistent: true,
    usePolling: true,   // Use polling - FSEvents can miss updates
    interval: 500,      // Poll every 500ms
    binaryInterval: 500
    // NOTE: No awaitWriteFinish — it suppresses/coalesces change events on
    // continuously-written log files, causing output to silently stop updating.
    // Partial lines are handled by the lastNewlineIndex guard below.
  });
  
  // Guard: prevent concurrent reads when fallback poll overlaps with chokidar
  let processing = false;

  async function processLogChanges() {
    if (processing) return;
    processing = true;
    try {
      // Loop to drain all available data (handles batches > MAX_READ_SIZE)
      let continueReading = true;
      while (continueReading) {
        continueReading = false;
        const stats = await fsp.stat(session.logFile);

        // Handle file truncation/rotation
        if (stats.size < lastPosition) {
          console.log(`[Watcher] File truncated, resetting position from ${lastPosition} to 0`);
          lastPosition = 0;
        }

        if (stats.size > lastPosition) {
          const bytesToRead = Math.min(stats.size - lastPosition, MAX_READ_SIZE);
          const fh = await fsp.open(session.logFile, 'r');
          const buffer = Buffer.alloc(bytesToRead);
          try {
            await fh.read(buffer, 0, bytesToRead, lastPosition);
          } finally {
            await fh.close();
          }

          const newContent = buffer.toString('utf8');
          const lastNewlineIndex = newContent.lastIndexOf('\n');
          if (lastNewlineIndex === -1) break; // No complete lines yet

          const completeContent = newContent.substring(0, lastNewlineIndex);
          // Calculate byte length of consumed content (including the newline)
          // so lastPosition stays aligned with the file's byte offset
          const consumedBytes = Buffer.byteLength(completeContent + '\n', 'utf8');
          const lines = completeContent.split('\n').filter(line => line.trim());

          let linesProcessed = false;
          // Parse all lines first, then filter auto-approved permissions
          const allItems = [];
          for (const line of lines) {
            try {
              const entry = JSON.parse(line);

              // Skip Task (subagent) tool results — streamed via subagent_output
              // But signal completion immediately instead of waiting for 30s idle timeout
              if (entry.type === 'user' && entry.toolUseResult?.agentId) {
                stopSubagent(sessionId, entry.toolUseResult.agentId, 'task completed');
                continue;
              }

              const parsed = parseLogEntry(entry, activeSessions.get(sessionId));
              if (parsed) {
                linesProcessed = true;
                const items = Array.isArray(parsed) ? parsed : [parsed];
                allItems.push(...items);
              }
            } catch (e) {
              console.debug(`[Watcher] Skipped invalid JSON: ${e.message}`);
            }
          }

          // Auto-approved permission_requests (tool_result in same batch) are
          // converted to regular 'tool' items so the client still sees the tool call
          // and can merge the tool_result into it. Without this, the client gets
          // orphaned tool_results that can't be matched to a parent → wrong tool count.
          const resolvedToolUseIds = new Set(
            allItems
              .filter(i => i.type === 'tool_result' && i.toolUseId)
              .map(i => i.toolUseId)
          );
          const filteredItems = allItems.map(item => {
            if (item.type === 'permission_request' && item.toolUseId && resolvedToolUseIds.has(item.toolUseId)) {
              return { ...item, type: 'tool' };
            }
            return item;
          });

          for (const item of filteredItems) {
            if (item.type === 'mode_change') {
              const sd = activeSessions.get(sessionId);
              if (sd && sd.mode !== item.mode) {
                sd.mode = item.mode;
                console.log(`[Mode] Session ${sessionId.substring(0, 8)} → ${item.mode}`);
                broadcastToClients({
                  type: 'mode_change',
                  sessionId: sessionId,
                  mode: item.mode
                });
              }
            } else if (item.type === 'subagent_starting') {
              // Broadcast as top-level message so iOS .subagentStarting handler
              // catches it (not buried inside claude_output where description/agentType
              // fields are lost by ClaudeOutputData decoding)
              broadcastToClients({
                type: 'subagent_starting',
                sessionId: sessionId,
                description: item.description,
                agentType: item.agentType
              });
            } else if (item.type === 'permission_resolved') {
              // Broadcast as top-level so clients can dismiss permission cards
              broadcastToClients({
                type: 'permission_resolved',
                sessionId: sessionId,
                toolUseId: item.toolUseId
              });
            } else if (item.type === 'task_create' || item.type === 'task_update' || item.type === 'task_list') {
              // Broadcast task messages as top-level so iOS decodes them as
              // .taskCreate / .taskUpdate / .taskList (not wrapped in claude_output)
              broadcastToClients(Object.assign({}, item, { sessionId }));
            } else if (item.type === 'team_create') {
              const sd = activeSessions.get(sessionId);
              if (sd) {
                // Clear any previous team before setting new one
                sd.activeTeam = {
                  name: item.teamName,
                  members: new Map(),
                  createdAt: item.timestamp
                };
                sd.teamMessages = [];
              }
              broadcastToClients({
                type: 'team_create',
                sessionId,
                teamName: item.teamName,
                timestamp: item.timestamp
              });
            } else if (item.type === 'team_delete') {
              const sd = activeSessions.get(sessionId);
              if (sd) {
                sd.activeTeam = null;
                sd.teamMessages = [];
              }
              broadcastToClients({
                type: 'team_delete',
                sessionId,
                timestamp: item.timestamp
              });
            } else if (item.type === 'team_message') {
              const sd = activeSessions.get(sessionId);
              if (sd) {
                const msg = {
                  sender: item.sender,
                  recipient: item.recipient,
                  content: item.content,
                  messageType: item.messageType,
                  timestamp: item.timestamp
                };
                sd.teamMessages.push(msg);
                // Cap at 50 messages
                if (sd.teamMessages.length > 50) {
                  sd.teamMessages = sd.teamMessages.slice(-50);
                }
              }
              broadcastToClients({
                type: 'team_message',
                sessionId,
                sender: item.sender,
                recipient: item.recipient,
                content: item.content,
                messageType: item.messageType,
                timestamp: item.timestamp
              });
            } else {
              broadcastToClients({
                type: 'claude_output',
                sessionId: sessionId,
                data: item
              });
            }
          }

          // Advance position BEFORE milestone detection so an error in
          // milestone logic never stalls the watcher (messages still flow).
          lastPosition += consumedBytes;

          // Milestone detection — run after broadcast loop
          try {
            const sd = activeSessions.get(sessionId);
            if (sd) {
              for (const item of filteredItems) {
                const milestone = detectMilestone(item, sd);
                if (milestone) {
                  broadcastToClients({
                    type: 'session_milestone',
                    sessionId: sessionId,
                    text: milestone.text,
                    timestamp: milestone.timestamp,
                    toolCount: milestone.toolCount
                  });
                }
              }
            }
          } catch (e) {
            console.error('[Milestone] Detection error (non-fatal):', e.message);
          }

          if (linesProcessed) {
            const newStatus = await getSessionStatus(session.logFile);
            const sessionData = activeSessions.get(sessionId);
            if (sessionData && newStatus !== sessionData.lastStatus) {
              sessionData.lastStatus = newStatus;
              broadcastToClients({
                type: 'session_status',
                sessionId: sessionId,
                status: newStatus
              });
            }
          }

          // More data remains — continue draining
          if (stats.size > lastPosition) {
            continueReading = true;
          }
        }
      }
    } catch (e) {
      console.error('Error reading log file:', e);
    } finally {
      processing = false;
    }
  }

  watcher.on('change', () => processLogChanges());

  // Watch logs directory for awareness only — no auto-switch, which would cause
  // watchers to accidentally follow unrelated sessions sharing the same project dir
  const logsDir = path.dirname(session.logFile);
  const logsDirWatcher = chokidar.watch(logsDir, {
    persistent: true,
    ignoreInitial: true,
    depth: 0
  });

  logsDirWatcher.on('add', (newFile) => {
    if (newFile.endsWith('.jsonl')) {
      console.log(`[Session ${sessionId.substring(0, 8)}] New log file in project dir: ${path.basename(newFile)}`);

      // If this session has a pendingClear, the new file is the post-/clear session
      const sd = activeSessions.get(sessionId);
      if (sd && sd.pendingClear) {
        const newSessionId = path.basename(newFile, '.jsonl');
        if (newSessionId !== sessionId) {
          handleNewSessionAfterClear(sessionId, newSessionId, newFile);
        }
      }
    }
  });

  // Fallback poll: catches missed chokidar events. macOS FSEvents and polling
  // can both miss rapid writes. Ensures output never silently stops updating.
  const FALLBACK_POLL_MS = 2000;
  const fallbackPoll = setInterval(() => processLogChanges(), FALLBACK_POLL_MS);
  
  const initialStatus = await getSessionStatus(session.logFile);

  const allowedTools = await loadAllowedTools(session.cwd);

  activeSessions.set(sessionId, {
    watcher,
    logsDirWatcher,
    pollInterval: fallbackPoll,
    session,
    lastPosition,
    lastStatus: initialStatus,
    mode: 'default',             // Current permission mode (updated from JSONL)
    contextPercentage: 0,        // Latest context % from statusline file
    contextPollInterval: null,   // Interval handle for /tmp/claude-ctx-* polling
    subagentWatchers: new Map(),  // Track subagent file watchers
    subagentPositions: new Map(), // Track read positions per subagent
    subagentTimeouts: new Map(),  // Track inactivity timeouts per subagent
    subagentInfo: new Map(),      // Track subagent metadata for sync to new clients
    allowedTools,                 // Pre-allowed tools from Claude Code settings
    sessionGranted: new Set(),    // Tools granted "always" during this session
    permissionToolMap: new Map(), // toolUseId -> {tool, timestamp} for accurate "always" tracking
    tasks: new Map(),             // Accumulated task state: taskId -> {id, subject, status, description, activeForm}
    pendingTaskListIds: new Set(), // tool_use IDs for TaskList calls — gates parseTaskListResult to only run on TaskList results
    milestones: [],               // Ring buffer of milestone objects (max 20)
    toolBurstCount: 0,            // Running count of consecutive tool calls for milestone detection
    activeTeam: null,             // Active team: { name, members: Map, createdAt }
    teamMessages: []              // Inter-teammate messages (capped at 50)
  });

  // Poll /tmp/claude-ctx-{sessionId} for context percentage updates
  const CONTEXT_POLL_MS = 10000;
  const ctxFile = `/tmp/claude-ctx-${sessionId}`;
  const contextPollInterval = setInterval(async () => {
    try {
      const content = await fsp.readFile(ctxFile, 'utf8');
      const pct = parseInt(content.trim(), 10);
      if (isNaN(pct)) return;
      const clamped = Math.max(0, Math.min(pct, 100));
      const sd = activeSessions.get(sessionId);
      if (sd && clamped !== sd.contextPercentage) {
        sd.contextPercentage = clamped;
        broadcastToClients({
          type: 'context_percentage',
          sessionId: sessionId,
          percentage: clamped
        });
      }
    } catch (e) {
      // File doesn't exist yet — that's fine
    }
  }, CONTEXT_POLL_MS);
  activeSessions.get(sessionId).contextPollInterval = contextPollInterval;

  // Watch for subagents in {sessionDir}/subagents/
  const subagentsDir = path.join(logsDir, sessionId, 'subagents');
  watchSubagentsDirectory(sessionId, subagentsDir);

  console.log(`[Session] Now watching: ${session.name} -> ${session.logFile}`);
  
  return session;
}

function unwatchSession(sessionId) {
  if (activeSessions.has(sessionId)) {
    const sessionData = activeSessions.get(sessionId);
    sessionData.watcher.close();
    sessionData.logsDirWatcher?.close();
    sessionData.subagentsDirWatcher?.close();
    sessionData.subagentsParentWatcher?.close();
    if (sessionData.pollInterval) clearInterval(sessionData.pollInterval);
    if (sessionData.contextPollInterval) clearInterval(sessionData.contextPollInterval);

    // Clean up subagent watchers
    sessionData.subagentWatchers?.forEach((watcher, agentId) => {
      watcher.close();
      console.log(`[Subagent] Stopped watching: ${agentId}`);
    });
    sessionData.subagentTimeouts?.forEach(timeout => clearTimeout(timeout));

    activeSessions.delete(sessionId);
  }
}

// ============================================
// Subagent Watching
// ============================================

const SUBAGENT_IDLE_TIMEOUT = 30000; // 30 seconds of inactivity = stopped

function watchSubagentsDirectory(sessionId, subagentsDir) {
  // Check if directory exists first
  fsp.access(subagentsDir).then(async () => {
    // Scan for recently active subagent files (modified within last 60 seconds)
    // These are likely still running and should be watched
    try {
      const files = await fsp.readdir(subagentsDir);
      const now = Date.now();
      for (const file of files) {
        if (file.endsWith('.jsonl')) {
          const filePath = path.join(subagentsDir, file);
          const stats = await fsp.stat(filePath);
          const ageMs = now - stats.mtimeMs;
          if (ageMs < 60000) { // Modified within last 60 seconds
            const agentId = file.replace('agent-', '').replace('.jsonl', '');
            console.log(`[Subagent] Found recently active: ${agentId} (${Math.round(ageMs/1000)}s old)`);
            watchSubagent(sessionId, agentId, filePath, false); // existing file
          }
        }
      }
    } catch (e) {
      console.error('[Subagent] Error scanning existing files:', e);
    }

    // Watch for new subagent files
    const subagentsDirWatcher = chokidar.watch(subagentsDir, {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 }
    });

    subagentsDirWatcher.on('add', (filePath) => {
      if (filePath.endsWith('.jsonl')) {
        const agentId = path.basename(filePath, '.jsonl').replace('agent-', '');
        watchSubagent(sessionId, agentId, filePath, true); // new file
      }
    });

    // Store watcher for cleanup
    const sessionData = activeSessions.get(sessionId);
    if (sessionData) {
      sessionData.subagentsDirWatcher = subagentsDirWatcher;
    }
  }).catch(() => {
    // Directory doesn't exist yet - watch parent for its creation
    const parentDir = path.dirname(subagentsDir);
    const parentWatcher = chokidar.watch(parentDir, {
      persistent: true,
      ignoreInitial: true,
      depth: 0
    });

    parentWatcher.on('addDir', (dirPath) => {
      if (dirPath === subagentsDir) {
        parentWatcher.close();
        watchSubagentsDirectory(sessionId, subagentsDir);
      }
    });

    const sessionData = activeSessions.get(sessionId);
    if (sessionData) {
      sessionData.subagentsParentWatcher = parentWatcher;
    }
  });
}

async function watchSubagent(sessionId, agentId, logFile, isNew = true) {
  const sessionData = activeSessions.get(sessionId);
  if (!sessionData) return;

  // Already watching this subagent
  if (sessionData.subagentWatchers.has(agentId)) return;

  console.log(`[Subagent] Now watching: ${agentId} -> ${logFile} (${isNew ? 'new' : 'existing'})`);

  // Start from beginning to catch any content already written (fixes race condition
  // where permission requests are written before watcher is set up)
  sessionData.subagentPositions.set(agentId, 0);

  // Try to correlate with pending subagent description (within 10 seconds)
  let description = null;
  let agentType = null;
  let teamName = null;
  let memberName = null;
  const now = Date.now();
  for (const [timestamp, info] of pendingSubagentDescriptions) {
    if (now - timestamp < 10000) { // Within 10 seconds
      description = info.description;
      agentType = info.type;
      teamName = info.teamName || null;
      memberName = info.memberName || null;
      pendingSubagentDescriptions.delete(timestamp);
      break;
    } else if (now - timestamp > 30000) {
      // Clean up old entries
      pendingSubagentDescriptions.delete(timestamp);
    }
  }

  // Store and broadcast subagent start with correlated description
  const subagentData = {
    description: description || agentId.substring(0, 8),
    agentType: agentType || 'general',
    startTime: Date.now(),
    inputTokens: 0,
    outputTokens: 0,
    currentTool: null,
    teamName,
    memberName
  };
  sessionData.subagentInfo.set(agentId, subagentData);

  // If this subagent is a teammate, register it in the active team
  if (teamName && sessionData.activeTeam) {
    sessionData.activeTeam.members.set(memberName || agentId, {
      agentId,
      name: memberName || agentId,
      startTime: subagentData.startTime
    });
  }

  const broadcastMsg = {
    type: 'subagent_start',
    sessionId,
    agentId,
    description: subagentData.description,
    agentType: subagentData.agentType,
    timestamp: subagentData.startTime
  };
  if (teamName) broadcastMsg.teamName = teamName;
  if (memberName) broadcastMsg.memberName = memberName;
  broadcastToClients(broadcastMsg);

  // Set up file watcher
  const watcher = chokidar.watch(logFile, {
    persistent: true,
    usePolling: true,
    interval: 500,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 }
  });

  // Deferred permission broadcast: hold permission_requests for one poll cycle
  // to let auto-approved tool_results arrive in the next batch. This prevents
  // flooding clients with stale permission prompts from bypassPermissions agents.
  const pendingPermissions = new Map(); // toolUseId -> item

  // Handler for processing file content
  // Lock prevents concurrent reads (immediate read + chokidar change can race)
  let processing = false;
  const processFileContent = async (filePath) => {
    if (processing) return;
    processing = true;
    try {
      const stats = await fsp.stat(filePath);
      let position = sessionData.subagentPositions.get(agentId) || 0;

      // Handle truncation
      if (stats.size < position) {
        position = 0;
      }

      if (stats.size > position) {
        const bytesToRead = Math.min(stats.size - position, MAX_READ_SIZE);
        const fh = await fsp.open(filePath, 'r');
        const buffer = Buffer.alloc(bytesToRead);
        try {
          await fh.read(buffer, 0, bytesToRead, position);
        } finally {
          await fh.close();
        }

        const newContent = buffer.toString('utf8');
        const lastNewlineIndex = newContent.lastIndexOf('\n');
        if (lastNewlineIndex === -1) {
          processing = false;
          return;
        }

        const completeContent = newContent.substring(0, lastNewlineIndex);
        const lines = completeContent.split('\n').filter(l => l.trim());

        // Parse all lines first, then filter auto-approved permissions
        const allItems = [];
        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            const parsed = parseLogEntry(entry, activeSessions.get(sessionId));
            if (parsed) {
              const items = Array.isArray(parsed) ? parsed : [parsed];
              for (const item of items) {
                item.subagentId = agentId;
                allItems.push(item);
              }
            }
          } catch (e) {
            // Skip invalid JSON
          }
        }

        // Collect resolved toolUseIds from this batch (same-batch filter)
        const resolvedToolUseIds = new Set(
          allItems
            .filter(i => i.type === 'tool_result' && i.toolUseId)
            .map(i => i.toolUseId)
        );

        // Resolve any deferred permissions from the PREVIOUS batch that now have
        // a tool_result — these were auto-approved between poll cycles
        for (const [toolUseId] of pendingPermissions) {
          if (resolvedToolUseIds.has(toolUseId)) {
            pendingPermissions.delete(toolUseId);
          }
        }

        // Broadcast any deferred permissions that survived — they're genuinely
        // waiting for user input (no tool_result after a full poll cycle)
        for (const [toolUseId, deferredItem] of pendingPermissions) {
          console.log(`[Subagent ${agentId}] deferred ${deferredItem.type} (confirmed pending)`);
          broadcastToClients({
            type: 'subagent_output',
            sessionId,
            agentId,
            data: deferredItem
          });
          pendingPermissions.delete(toolUseId);
        }

        for (const item of allItems) {
          // Same-batch auto-approved — skip entirely
          if (item.type === 'permission_request' && item.toolUseId && resolvedToolUseIds.has(item.toolUseId)) {
            continue;
          }

          // Permission requests: defer broadcast to next poll cycle to catch
          // cross-batch auto-approvals (e.g. bypassPermissions agents where
          // tool_result arrives milliseconds after permission_request)
          if (item.type === 'permission_request' && item.toolUseId) {
            pendingPermissions.set(item.toolUseId, item);
            continue;
          }

          // ask_user_question: broadcast immediately (not permission-gated)
          if (item.type === 'ask_user_question') {
            console.log(`[Subagent ${agentId}] ${item.type}`);
            broadcastToClients({
              type: 'subagent_output',
              sessionId,
              agentId,
              data: item
            });
          }

          // Broadcast permission_resolved as top-level event (same as main watcher)
          if (item.type === 'permission_resolved') {
            broadcastToClients({
              type: 'permission_resolved',
              sessionId,
              toolUseId: item.toolUseId
            });
          }

          // Capture team messages from teammate subagents
          if (item.type === 'team_message') {
            const sd = activeSessions.get(sessionId);
            if (sd) {
              // Use the teammate's memberName as sender instead of generic 'lead'
              const info = sd.subagentInfo.get(agentId);
              const senderName = info?.memberName || agentId.substring(0, 8);
              const msg = {
                sender: senderName,
                recipient: item.recipient,
                content: item.content,
                messageType: item.messageType,
                timestamp: item.timestamp
              };
              sd.teamMessages.push(msg);
              if (sd.teamMessages.length > 50) {
                sd.teamMessages = sd.teamMessages.slice(-50);
              }
            }
            broadcastToClients({
              type: 'team_message',
              sessionId,
              sender: activeSessions.get(sessionId)?.subagentInfo.get(agentId)?.memberName || agentId.substring(0, 8),
              recipient: item.recipient,
              content: item.content,
              messageType: item.messageType,
              timestamp: item.timestamp
            });
          }

          // Emit specific events for tool usage (throttled activity card updates)
          if (item.type === 'tool' || item.type === 'permission_request') {
            // Update stored subagent info
            const info = sessionData.subagentInfo.get(agentId);
            if (info) {
              info.currentTool = item.tool;
            }
            // Throttle subagent_tool to max 1 per 500ms per agent
            const now = Date.now();
            const lastSent = subagentToolThrottles.get(agentId) || 0;
            if (now - lastSent >= SUBAGENT_TOOL_THROTTLE_MS) {
              subagentToolThrottles.set(agentId, now);
              broadcastToClients({
                type: 'subagent_tool',
                sessionId,
                agentId,
                tool: item.tool,
                input: item.input
              });
            }
          }
          if (item.type === 'token_usage') {
            // Update stored subagent info
            const info = sessionData.subagentInfo.get(agentId);
            if (info) {
              info.inputTokens = (info.inputTokens || 0) + (item.input || 0);
              info.outputTokens = (info.outputTokens || 0) + (item.output || 0);
            }
            broadcastToClients({
              type: 'subagent_tokens',
              sessionId,
              agentId,
              input: item.input,
              output: item.output
            });
          }
        }

        sessionData.subagentPositions.set(agentId, position + lastNewlineIndex + 1);

        // Reset idle timeout
        resetSubagentIdleTimeout(sessionId, agentId);
      }
    } catch (e) {
      console.error(`[Subagent ${agentId}] Error:`, e.message);
    } finally {
      processing = false;
    }
  };

  // Bind handler to change events
  watcher.on('change', processFileContent);

  sessionData.subagentWatchers.set(agentId, watcher);

  // IMMEDIATELY read existing content (fixes race condition where subagent
  // writes everything before watcher is ready)
  console.log(`[Subagent ${agentId}] Triggering immediate read of ${logFile}`);
  processFileContent(logFile);

  // Set initial idle timeout
  resetSubagentIdleTimeout(sessionId, agentId);
}

function resetSubagentIdleTimeout(sessionId, agentId) {
  const sessionData = activeSessions.get(sessionId);
  if (!sessionData) return;

  // Clear existing timeout
  const existingTimeout = sessionData.subagentTimeouts.get(agentId);
  if (existingTimeout) {
    clearTimeout(existingTimeout);
  }

  // Set new timeout
  const timeout = setTimeout(() => {
    stopSubagent(sessionId, agentId);
  }, SUBAGENT_IDLE_TIMEOUT);

  sessionData.subagentTimeouts.set(agentId, timeout);
}

function stopSubagent(sessionId, agentId, reason) {
  const sessionData = activeSessions.get(sessionId);
  if (!sessionData) return;

  const watcher = sessionData.subagentWatchers.get(agentId);
  if (watcher) {
    watcher.close();
    sessionData.subagentWatchers.delete(agentId);
    sessionData.subagentPositions.delete(agentId);
    sessionData.subagentInfo.delete(agentId);
    subagentToolThrottles.delete(agentId);

    const timeout = sessionData.subagentTimeouts.get(agentId);
    if (timeout) {
      clearTimeout(timeout);
      sessionData.subagentTimeouts.delete(agentId);
    }

    console.log(`[Subagent ${agentId}] Stopped (${reason || 'idle timeout'})`);

    broadcastToClients({
      type: 'subagent_stop',
      sessionId,
      agentId,
      timestamp: Date.now()
    });
  }
}

// ============================================
// Milestone Detection
// ============================================
// Detects "milestones" — assistant messages that follow a burst of 2+ tool calls.
// These represent moments where Claude pauses to report progress after doing work.
const MAX_MILESTONES = 20;

/**
 * Process a single parsed item for milestone detection.
 * Mutates sessionData.toolBurstCount and sessionData.milestones.
 * Returns a milestone object if one was detected, null otherwise.
 */
function detectMilestone(item, sessionData) {
  if (!sessionData) return null;

  // Tool-like items increment the burst counter
  if (item.type === 'tool' || item.type === 'permission_request' ||
      (item.type === 'status_update' && item.tool)) {
    sessionData.toolBurstCount++;
    return null;
  }

  // Assistant text after 2+ tool calls = milestone
  if (item.type === 'assistant' && sessionData.toolBurstCount >= 2) {
    const milestone = {
      text: item.content || '',
      timestamp: item.timestamp || new Date().toISOString(),
      toolCount: sessionData.toolBurstCount
    };
    sessionData.milestones.push(milestone);
    // Evict oldest if over capacity
    while (sessionData.milestones.length > MAX_MILESTONES) {
      sessionData.milestones.shift();
    }
    sessionData.toolBurstCount = 0;
    return milestone;
  }

  // Assistant with < 2 tools, or user message — reset burst
  if (item.type === 'assistant' || item.type === 'user') {
    sessionData.toolBurstCount = 0;
  }

  return null;
}

/**
 * Scan an array of parsed items and extract all milestones.
 * Returns an array of milestone objects. Mutates sessionData.toolBurstCount.
 */
function extractMilestones(items, sessionData) {
  const milestones = [];
  for (const item of items) {
    const m = detectMilestone(item, sessionData);
    if (m) milestones.push(m);
  }
  return milestones;
}

// parseTaskListResult imported from ./lib/parsers.js

function parseLogEntry(entry, sessionData) {
  const results = [];
  const timestamp = entry.timestamp || new Date().toISOString();

  // Handle progress entries - broadcast status updates with random spinner verb
  if (entry.type === 'progress') {
    return [{
      type: 'status_update',
      content: `${getRandomSpinnerVerb()}...`,
      timestamp: entry.timestamp || new Date().toISOString()
    }];
  }

  // Skip system entries
  if (entry.type === 'system') return null;

  // Note: compaction is detected via <local-command-stdout> containing "Compacted"
  // in the user entry handler below (not via a top-level type)

  // Assistant messages - extract text and tool uses from message.content
  if (entry.type === 'assistant' && entry.message?.content) {
    const content = entry.message.content;

    if (Array.isArray(content)) {
      for (const block of content) {
        // Text content - this is what Claude says
        if (block.type === 'text' && block.text) {
          results.push({
            type: 'assistant',
            content: block.text,
            timestamp
          });
        }
        // Thinking content - emit status update with random spinner verb
        else if (block.type === 'thinking') {
          results.push({
            type: 'status_update',
            content: `${getRandomSpinnerVerb()}...`,
            timestamp
          });
        }
        // Tool use - Claude calling a tool
        else if (block.type === 'tool_use') {
          // Emit status update with random spinner verb (like terminal)
          results.push({
            type: 'status_update',
            content: `${getRandomSpinnerVerb()}...`,
            tool: block.name,
            timestamp
          });

          const isMcpTool = block.name && block.name.startsWith('mcp__');

          // Special handling for AskUserQuestion - emit as structured prompt
          if (block.name === 'AskUserQuestion' && block.input?.questions) {
            results.push({
              type: 'ask_user_question',
              questions: block.input.questions,
              timestamp
            });
          }
          // Permission-requiring tools - only emit if not pre-allowed
          else if (needsPermission(block.name, sessionData) || (isMcpTool && needsPermission(block.name, sessionData))) {
            console.log(`[Permission] Detected ${block.name} tool call`);
            if (sessionData && block.id) {
              // Clean stale entries (>600s / 10 min) before adding new one
              const now = Date.now();
              for (const [id, entry] of sessionData.permissionToolMap) {
                if (now - entry.timestamp > 600000) {
                  sessionData.permissionToolMap.delete(id);
                }
              }
              sessionData.permissionToolMap.set(block.id, { tool: block.name, timestamp: now });
            }
            results.push({
              type: 'permission_request',
              tool: isMcpTool ? formatMcpToolName(block.name) : block.name,
              input: isMcpTool ? sanitizeMcpInput(block.input) : (block.input || {}),
              toolUseId: block.id || null,
              timestamp
            });
          }
          // Task management tools - emit for task tracking
          else if (block.name === 'TaskCreate') {
            const pendingId = 'pending-' + Date.now();
            if (block.id) {
              pendingTaskIds.set(block.id, pendingId);
            }
            const taskData = {
              id: pendingId,
              subject: block.input?.subject,
              description: block.input?.description,
              activeForm: block.input?.activeForm,
              status: 'pending'
            };
            if (sessionData) {
              sessionData.tasks.set(pendingId, taskData);
            }
            results.push({ type: 'task_create', ...taskData });
          }
          else if (block.name === 'TaskUpdate') {
            const realId = String(block.input?.taskId ?? '');
            const mappedId = taskIdMap.get(realId) || realId;
            const newStatus = block.input?.status;
            if (sessionData) {
              if (newStatus === 'deleted') {
                sessionData.tasks.delete(mappedId);
              } else {
                const existing = sessionData.tasks.get(mappedId) || { id: mappedId };
                sessionData.tasks.set(mappedId, {
                  ...existing,
                  status: newStatus ?? existing.status,
                  subject: block.input?.subject ?? existing.subject,
                  description: block.input?.description ?? existing.description,
                  activeForm: block.input?.activeForm ?? existing.activeForm
                });
              }
            }
            results.push({
              type: 'task_update',
              taskId: mappedId,
              status: newStatus,
              subject: block.input?.subject,
              description: block.input?.description,
              activeForm: block.input?.activeForm
            });
          }
          else if (block.name === 'TaskList') {
            // Track this tool_use ID so we only run parseTaskListResult on actual TaskList results
            if (sessionData && block.id) {
              sessionData.pendingTaskListIds.add(block.id);
            }
          }
          else if (block.name === 'EnterPlanMode') {
            results.push({ type: 'mode_change', mode: 'plan', timestamp });
          }
          else if (block.name === 'ExitPlanMode') {
            results.push({ type: 'mode_change', mode: 'default', timestamp });
            // Also emit exit_plan_mode for interactive prompt (separate from mode_change state tracking)
            results.push({ type: 'exit_plan_mode', timestamp });
          }
          else if (block.name === 'Task') {
            // Subagent being spawned - track description for correlation
            const agentDescription = block.input?.description || 'Subagent';
            const agentType = block.input?.subagent_type || 'general';
            const teamName = block.input?.team_name || null;
            const memberName = block.input?.name || null;
            pendingSubagentDescriptions.set(Date.now(), {
              description: agentDescription,
              type: agentType,
              teamName,
              memberName
            });
            results.push({
              type: 'subagent_starting',
              content: agentDescription,
              tool: agentType,
              description: agentDescription,
              agentType: agentType,
              teamName,
              memberName,
              timestamp
            });
          }
          else if (block.name === 'TeamCreate') {
            const teamName = block.input?.team_name || 'unnamed-team';
            results.push({
              type: 'team_create',
              teamName,
              timestamp
            });
          }
          else if (block.name === 'TeamDelete') {
            results.push({
              type: 'team_delete',
              timestamp
            });
          }
          else if (block.name === 'SendMessage') {
            const msgType = block.input?.type;
            if (msgType === 'message' || msgType === 'broadcast') {
              results.push({
                type: 'team_message',
                sender: 'lead',
                recipient: block.input?.recipient || null,
                content: block.input?.content || '',
                messageType: msgType,
                timestamp
              });
            } else {
              // Other SendMessage types (shutdown_request, etc.) - emit as generic tool
              results.push({
                type: 'tool',
                tool: block.name,
                input: block.input || {},
                toolUseId: block.id || null,
                timestamp
              });
            }
          }
          // Other tools
          else {
            results.push({
              type: 'tool',
              tool: block.name || 'unknown',
              input: block.input || {},
              toolUseId: block.id || null,
              timestamp
            });
          }
        }
      }
    } else if (typeof content === 'string') {
      results.push({
        type: 'assistant',
        content: content,
        timestamp
      });
    }

  }

  // User messages - could be human input or tool results
  if (entry.type === 'user') {
    // Skip Task (subagent) tool results entirely - their output is streamed
    // via the subagent_output channel. Task results have agentId in toolUseResult.
    if (entry.toolUseResult?.agentId) {
      return null;
    }
    // Tool result - always emit when toolUseResult exists (even if no output)
    // This signals the tool completed, which is needed to dismiss permission cards
    if (entry.toolUseResult) {
      // Extract tool_use_id from content blocks for correlation with tool_use
      let toolUseId = null;
      if (Array.isArray(entry.message?.content)) {
        const resultBlock = entry.message.content.find(b => b.type === 'tool_result');
        toolUseId = resultBlock?.tool_use_id || null;
      }

      // Map TaskCreate tool_result to real task ID
      if (toolUseId && pendingTaskIds.has(toolUseId)) {
        const pendingId = pendingTaskIds.get(toolUseId);
        const result = stripAnsi(entry.toolUseResult.stdout || entry.toolUseResult.stderr || '');
        // TaskCreate result text contains "Created task N: ..." or "id: N"
        const idMatch = result.match(/(?:task\s+#?|id[:\s]+)(\d+)/i);
        if (idMatch) {
          taskIdMap.set(idMatch[1], pendingId);
        }
        pendingTaskIds.delete(toolUseId);
      }

      // Parse TaskList tool_result for authoritative task snapshot — only when
      // the tool_result corresponds to an actual TaskList tool_use (CONS-005).
      // Without this guard, any tool output matching "#N. [status] ..." would
      // wipe and replace sessionData.tasks.
      const isTaskListResult = toolUseId && sessionData?.pendingTaskListIds?.has(toolUseId);
      if (isTaskListResult) {
        sessionData.pendingTaskListIds.delete(toolUseId);
        const resultText = stripAnsi(entry.toolUseResult.stdout || entry.toolUseResult.stderr || '');
        const taskListItems = parseTaskListResult(resultText);
        if (taskListItems && taskListItems.length > 0) {
          sessionData.tasks.clear();
          for (const task of taskListItems) {
            const mappedId = taskIdMap.get(String(task.id)) || String(task.id);
            sessionData.tasks.set(mappedId, {
              id: mappedId,
              subject: task.subject,
              status: task.status,
              description: task.description || null,
              activeForm: task.activeForm || null
            });
          }
          results.push({
            type: 'task_list',
            tasks: Array.from(sessionData.tasks.values())
          });
        }
      }

      // permissionToolMap cleanup is TTL-based (600s) — not deleted here
      // because the user may click "Always Allow" after tool_result arrives.
      // But emit permission_resolved so clients can dismiss permission cards.
      if (toolUseId && sessionData?.permissionToolMap?.has(toolUseId)) {
        results.push({
          type: 'permission_resolved',
          toolUseId,
          timestamp
        });
      }

      const result = entry.toolUseResult.stdout || entry.toolUseResult.stderr || '';
      results.push({
        type: 'tool_result',
        content: stripAnsi(result.trim()) || '(completed)',
        isError: !!entry.toolUseResult.stderr && !entry.toolUseResult.stdout,
        toolUseId,
        timestamp
      });
    }
    // Skip meta-injected messages (skill definitions, system context)
    else if (entry.isMeta) {
      // These are CLI-injected messages (e.g. expanded skill prompts) — not user input
      return null;
    }
    // Human input
    else if (entry.message?.content) {
      const content = entry.message.content;
      if (typeof content === 'string') {
        // Skip command invocation wrappers (e.g. /compact, /help)
        if (content.includes('<command-message>') || content.includes('<command-name>')) {
          return null;
        }
        // Local command output — detect compaction completion
        if (content.includes('<local-command-stdout>')) {
          if (content.includes('Compacted')) {
            return [{ type: 'compaction_complete', content: 'Context compacted', timestamp }];
          }
          return null;
        }
        results.push({
          type: 'user',
          content: content,
          timestamp
        });
      } else if (Array.isArray(content)) {
        // Check for actual user text (not tool results)
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            results.push({
              type: 'user',
              content: block.text,
              timestamp
            });
          }
          // Skip tool_result blocks in user messages - we handle those via toolUseResult
        }
      }
    }

    // Extract permissionMode from user entries (present on human-typed messages)
    if (entry.permissionMode) {
      results.push({ type: 'mode_change', mode: entry.permissionMode, timestamp });
    }
  }

  // Return first result, or null if none
  // For multiple results (like text + tool use), we'll broadcast them separately
  if (results.length === 0) return null;
  if (results.length === 1) return results[0];

  // Multiple items - return as array for special handling
  return results;
}

async function getSessionStatus(logFile) {
  try {
    const stats = await fsp.stat(logFile);
    if (stats.size === 0) return 'idle';

    // Read last 10KB to check for pending prompts
    const fh = await fsp.open(logFile, 'r');
    const size = Math.min(stats.size, 10000);
    const buffer = Buffer.alloc(size);
    try {
      await fh.read(buffer, 0, size, stats.size - size);
    } finally {
      await fh.close();
    }

    const lines = buffer.toString('utf8').split('\n').filter(l => l.trim());
    if (lines.length === 0) return 'idle';

    // Parse last complete line
    const lastLine = lines[lines.length - 1];
    const entry = JSON.parse(lastLine);

    // Only show 'waiting' if there's an actual prompt needing user input
    if (entry.type === 'assistant' && entry.message?.content) {
      const content = entry.message.content;
      if (Array.isArray(content)) {
        // Check for AskUserQuestion tool use
        const hasAskUser = content.some(block =>
          block.type === 'tool_use' && block.name === 'AskUserQuestion'
        );
        if (hasAskUser) return 'waiting';

        // Check for unanswered tool use (permission request)
        // Look for tool_use in last entry without tool_result after it
        const hasToolUse = content.some(block => block.type === 'tool_use');
        if (hasToolUse) {
          // Check if there's a tool_result for it in subsequent entries
          const lastToolUseId = content.find(b => b.type === 'tool_use')?.id;
          // Look through recent lines for a tool_result with matching id
          let hasResult = false;
          for (let i = lines.length - 1; i >= Math.max(0, lines.length - 5); i--) {
            try {
              const checkEntry = JSON.parse(lines[i]);
              if (checkEntry.type === 'user' && Array.isArray(checkEntry.message?.content)) {
                hasResult = checkEntry.message.content.some(b =>
                  b.type === 'tool_result' && b.tool_use_id === lastToolUseId
                );
                if (hasResult) break;
              }
            } catch (e) {}
          }
          if (!hasResult) return 'waiting';
        }
      }
    }

    if (entry.type === 'progress') return 'processing';
    return 'active';
  } catch (e) {
    return 'unknown';
  }
}

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

function broadcastToClients(message) {
  // Log subagent-related messages for debugging
  if (message.type?.startsWith('subagent')) {
    console.log(`[BROADCAST] ${message.type} agentId=${message.agentId} dataType=${message.data?.type}`);
  }
  const data = JSON.stringify(message);
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

// Check if any other client is watching a session (excludes given ws)
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
    discoverCommands().then(commands => {
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
    // Session IDs are either UUIDs (from JSONL files) or tty-pid format
    if (!/^[a-f0-9-]+$/.test(msg.sessionId) || msg.sessionId.length > 100) {
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
          await sendRecentHistory(ws, msg.sessionId);
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
        sendError(ws, ErrorCodes.SESSION_NOT_FOUND, 'Session not found or no log file', { sessionId: msg.sessionId });
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
        sendRecentHistory(ws, msg.sessionId);
      }
      break;

    case 'inject':
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
        } catch (err) {
          console.error(`[Inject] Failed: ${err.message}`);
          ws.send(JSON.stringify({ type: 'inject_result', success: false, code: ErrorCodes.INJECT_FAILED, error: err.message }));
        }
      })();
      break;

    case 'select_option': {
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

    case 'escape':
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

    case 'ping':
      ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      break;

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

    // Read context percentage from statusline file (replaces JSONL token scanning)
    try {
      const ctxFile = `/tmp/claude-ctx-${sessionId}`;
      const ctxContent = await fsp.readFile(ctxFile, 'utf8');
      const pct = parseInt(ctxContent.trim(), 10);
      if (!isNaN(pct) && sessionData) {
        sessionData.contextPercentage = Math.max(0, Math.min(pct, 100));
      }
    } catch (e) {
      // File may not exist yet — context percentage stays at 0
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
          const parsed = parseLogEntry(entry, sessionData);
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

        const parsed = parseLogEntry(entry, sessionData);
        if (parsed) {
          const items = Array.isArray(parsed) ? parsed : [parsed];
          allItems.push(...items.filter(i =>
            i.type !== 'token_usage' && i.type !== 'mode_change' &&
            i.type !== 'task_create' && i.type !== 'task_update' && i.type !== 'task_list'
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

    // Read and send recent subagent output
    try {
      const logFile = path.join(subagentsDir, `agent-${agentId}.jsonl`);
      const content = await fsp.readFile(logFile, 'utf8');
      const lines = content.split('\n').filter(l => l.trim());

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          const parsed = parseLogEntry(entry, activeSessions.get(sessionId));
          if (parsed) {
            const items = Array.isArray(parsed) ? parsed : [parsed];
            for (const item of items) {
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

// ============================================
// Command Injection
// ============================================

// Rate limiting for command injection (security)
const commandRateLimit = {
  timestamps: [],
  maxCommands: 10,      // Max commands per window
  windowMs: 60 * 1000,  // 1 minute window
  check() {
    const now = Date.now();
    this.timestamps = this.timestamps.filter(t => now - t < this.windowMs);
    if (this.timestamps.length >= this.maxCommands) {
      return false;
    }
    this.timestamps.push(now);
    return true;
  }
};

// Inject command to a specific iTerm session by TTY (works on background tabs)
// Send a raw control character to a session (bypasses sanitizer)
// Common: 27 = Escape, 21 = Ctrl+U (clear line), 3 = Ctrl+C
function sendControlCharToTty(charCode, tty) {
  if (!/^ttys\d+$/.test(tty)) {
    return Promise.reject(new Error('Invalid TTY format'));
  }
  return new Promise((resolve, reject) => {
    const targetTty = `/dev/${tty}`;
    const appleScript = `
      tell application "iTerm2"
        repeat with w in windows
          repeat with t in tabs of w
            repeat with s in sessions of t
              if tty of s is "${targetTty}" then
                tell s to write text (ASCII character ${charCode}) newline no
                return "ok"
              end if
            end repeat
          end repeat
        end repeat
        return "not found"
      end tell
    `;
    exec(`osascript -e '${appleScript.replace(/'/g, "'\"'\"'")}'`, (err, stdout) => {
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}

// Prepare a session for command injection: cancel processing + clear input
async function prepareSessionForInjection(tty) {
  await sendControlCharToTty(27, tty);  // Escape — cancel any processing
  await new Promise(r => setTimeout(r, 1500));
  await sendControlCharToTty(21, tty);  // Ctrl+U — clear input line
  await new Promise(r => setTimeout(r, 500));
}

function injectCommandToTty(command, tty) {
  // Rate limit check
  if (!commandRateLimit.check()) {
    return Promise.reject(new Error('Rate limit exceeded: max 10 commands per minute'));
  }

  // Validate TTY format (e.g., "ttys001") to prevent path traversal
  if (!/^ttys\d+$/.test(tty)) {
    return Promise.reject(new Error('Invalid TTY format'));
  }

  return new Promise((resolve, reject) => {
    // Strip null bytes and control characters (except \t\n\r which are escaped below)
    const sanitized = command.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
    // Escape the command for AppleScript string (prevent injection)
    const escaped = sanitized
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n')
      .replace(/\t/g, '\\t');
    const targetTty = `/dev/${tty}`;

    // Use iTerm's native write text command - works on any session without activation
    // Write text without auto-newline, delay briefly, then send CR to submit
    const appleScript = `
      tell application "iTerm2"
        repeat with w in windows
          repeat with t in tabs of w
            repeat with s in sessions of t
              if tty of s is "${targetTty}" then
                tell s
                  write text "${escaped}" newline no
                  delay 0.2
                  write text (ASCII character 13) newline no
                end tell
                return "ok"
              end if
            end repeat
          end repeat
        end repeat
        return "not found"
      end tell
    `;

    exec(`osascript -e '${appleScript.replace(/'/g, "'\"'\"'")}'`, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
      } else if (stdout.trim() === 'not found') {
        reject(new Error(`Session with TTY ${tty} not found`));
      } else {
        console.log(`[Inject TTY ${tty}] ${command.substring(0, 50)}${command.length > 50 ? '...' : ''}`);
        resolve();
      }
    });
  });
}

// Navigate an interactive selector by sending arrow-down keys then Enter.
// Used for AskUserQuestion prompts where the ink Select component only
// responds to arrow keys, not typed text.
function selectOptionInTty(index, tty) {
  if (!commandRateLimit.check()) {
    return Promise.reject(new Error('Rate limit exceeded: max 10 commands per minute'));
  }
  if (!/^ttys\d+$/.test(tty)) {
    return Promise.reject(new Error('Invalid TTY format'));
  }

  return new Promise((resolve, reject) => {
    const targetTty = `/dev/${tty}`;

    // Build arrow-down sequence: ESC (ASCII 27) + "[B" for each step
    let arrowCommands = '';
    for (let i = 0; i < index; i++) {
      arrowCommands += `                    write text (ASCII character 27) & "[B" newline no\n`;
    }

    const appleScript = `
      tell application "iTerm2"
        repeat with w in windows
          repeat with t in tabs of w
            repeat with s in sessions of t
              if tty of s is "${targetTty}" then
                tell s
${arrowCommands}                    write text (ASCII character 13) newline no
                end tell
                return "ok"
              end if
            end repeat
          end repeat
        end repeat
        return "not found"
      end tell
    `;

    exec(`osascript -e '${appleScript.replace(/'/g, "'\"'\"'")}'`, (err, stdout) => {
      if (err) {
        reject(new Error(err.message));
      } else if (stdout.trim() === 'not found') {
        reject(new Error(`Session with TTY ${tty} not found`));
      } else {
        console.log(`[SelectOption TTY ${tty}] index=${index}`);
        resolve();
      }
    });
  });
}

// Send escape key to a specific iTerm session by TTY
function sendEscapeKeyToTty(tty) {
  return new Promise((resolve, reject) => {
    const targetTty = `/dev/${tty}`;

    // Write escape character (ASCII 27) directly to the session
    const appleScript = `
      tell application "iTerm2"
        repeat with w in windows
          repeat with t in tabs of w
            repeat with s in sessions of t
              if tty of s is "${targetTty}" then
                tell s to write text (ASCII character 27) newline no
                return "ok"
              end if
            end repeat
          end repeat
        end repeat
        return "not found"
      end tell
    `;

    exec(`osascript -e '${appleScript.replace(/'/g, "'\"'\"'")}'`, (error, stdout) => {
      if (error) reject(error);
      else if (stdout.trim() === 'not found') {
        reject(new Error(`Session with TTY ${tty} not found`));
      } else {
        console.log(`[Inject TTY ${tty}] Escape key`);
        resolve();
      }
    });
  });
}

// Send Shift+Tab to toggle mode (activates iTerm - no background option)
function sendModeToggle() {
  return new Promise((resolve, reject) => {
    const appleScript = `
      tell application "iTerm2" to activate
      delay 0.1
      tell application "System Events"
        key code 48 using shift down
      end tell
    `;

    exec(`osascript -e '${appleScript.replace(/'/g, "'\"'\"'")}'`, (error) => {
      if (error) {
        console.error('[Mode Toggle] Failed:', error.message);
        reject(error);
      } else {
        console.log('[Mode Toggle] Sent Shift+Tab');
        resolve();
      }
    });
  });
}

// Legacy injection (activates iTerm - used as fallback)
function injectCommandLegacy(command) {
  if (!commandRateLimit.check()) {
    return Promise.reject(new Error('Rate limit exceeded: max 10 commands per minute'));
  }

  return new Promise((resolve, reject) => {
    const pbcopy = exec('pbcopy', (error) => {
      if (error) {
        reject(new Error('Failed to copy to clipboard'));
        return;
      }

      const appleScript = `
        tell application "iTerm" to activate
        delay 0.4
        tell application "System Events" to tell process "iTerm2"
          keystroke "v" using command down
          delay 0.3
          keystroke return
        end tell
      `;

      exec(`osascript -e '${appleScript}'`, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr || err.message));
        } else {
          console.log(`[Inject Legacy] ${command.substring(0, 50)}${command.length > 50 ? '...' : ''}`);
          resolve();
        }
      });
    });

    pbcopy.stdin.write(command);
    pbcopy.stdin.end();
  });
}

function sendEscapeKeyLegacy() {
  const appleScript = `
    tell application "iTerm"
      activate
      delay 0.2
      tell application "System Events"
        tell process "iTerm2"
          key code 53
        end tell
      end tell
    end tell
  `;

  return new Promise((resolve, reject) => {
    exec(`osascript -e '${appleScript.replace(/'/g, "'\"'\"'")}'`, (error) => {
      if (error) reject(error);
      else {
        console.log('[Inject Legacy] Escape key');
        resolve();
      }
    });
  });
}

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
// File Browsing API
// ============================================

// Directories to exclude from file listings
const EXCLUDED_DIRS = new Set(['.git', 'node_modules', '.build', 'build']);

// Map file extensions to language identifiers for syntax highlighting
const EXTENSION_TO_LANGUAGE = {
  '.swift': 'swift', '.js': 'javascript', '.ts': 'typescript',
  '.jsx': 'jsx', '.tsx': 'tsx', '.py': 'python', '.rb': 'ruby',
  '.go': 'go', '.rs': 'rust', '.java': 'java', '.kt': 'kotlin',
  '.c': 'c', '.cpp': 'cpp', '.h': 'c', '.hpp': 'cpp',
  '.cs': 'csharp', '.php': 'php', '.sh': 'bash', '.zsh': 'bash',
  '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml',
  '.xml': 'xml', '.html': 'html', '.css': 'css', '.scss': 'scss',
  '.sql': 'sql', '.md': 'markdown', '.r': 'r', '.lua': 'lua',
  '.dart': 'dart', '.ex': 'elixir', '.exs': 'elixir',
  '.zig': 'zig', '.v': 'v', '.nim': 'nim',
};

// Helper: authenticate a REST request via Bearer token
function authenticateRequest(req, res) {
  const auth = req.headers.authorization;
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!secureCompare(token, AUTH_TOKEN)) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}

// Simple rate limiter for file API — 120 requests per minute per IP
const fileApiRateLimit = new Map(); // ip -> { count, resetTime }
function checkFileApiRate(req, res) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  let entry = fileApiRateLimit.get(ip);
  if (!entry || now > entry.resetTime) {
    entry = { count: 0, resetTime: now + 60000 };
    fileApiRateLimit.set(ip, entry);
  }
  entry.count++;
  if (entry.count > 120) {
    res.status(429).json({ error: 'Too many requests' });
    return false;
  }
  return true;
}

// Helper: resolve session cwd from sessionId
async function resolveSessionCwd(sessionId, res) {
  // Check active sessions first
  const active = activeSessions.get(sessionId);
  if (active?.session?.cwd) return active.session.cwd;

  // Fall back to discovering sessions
  const sessions = await discoverSessions();
  const session = sessions.find(s => s.id === sessionId);
  if (!session?.cwd) {
    res.status(404).json({ error: 'Session not found' });
    return null;
  }
  return session.cwd;
}

// Helper: validate path is within cwd (prevent traversal)
async function validatePath(cwd, requestedPath, res) {
  const resolved = path.resolve(cwd, requestedPath);
  if (!resolved.startsWith(cwd + path.sep) && resolved !== cwd) {
    res.status(403).json({ error: 'Path traversal denied' });
    return null;
  }
  // Resolve symlinks to prevent escaping cwd via symlink targets
  try {
    const realCwd = await fsp.realpath(cwd);
    const realResolved = await fsp.realpath(resolved);
    if (!realResolved.startsWith(realCwd + path.sep) && realResolved !== realCwd) {
      res.status(403).json({ error: 'Path traversal denied' });
      return null;
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.status(404).json({ error: 'Path not found' });
      return null;
    }
    // For other errors (EACCES etc.), fall through to let the caller handle it
  }
  return resolved;
}

// Validate sessionId format: non-empty string, max 256 chars, no path separators
function validateSessionId(sessionId, res) {
  if (!sessionId || typeof sessionId !== 'string') {
    res.status(400).json({ error: 'sessionId required' });
    return false;
  }
  if (sessionId.length > 256 || /[\/\\]/.test(sessionId)) {
    res.status(400).json({ error: 'Invalid sessionId format' });
    return false;
  }
  return true;
}

// GET /api/files - List directory contents
app.get('/api/files', async (req, res) => {
  if (!authenticateRequest(req, res)) return;
  if (!checkFileApiRate(req, res)) return;

  const { sessionId, path: reqPath = '.' } = req.query;
  if (!validateSessionId(sessionId, res)) return;

  const cwd = await resolveSessionCwd(sessionId, res);
  if (!cwd) return;

  const resolved = await validatePath(cwd, reqPath, res);
  if (!resolved) return;

  try {
    const dirents = await fsp.readdir(resolved, { withFileTypes: true });
    const entries = [];

    for (const dirent of dirents) {
      // Skip excluded directories
      if (dirent.isDirectory() && EXCLUDED_DIRS.has(dirent.name)) continue;
      // Skip hidden files/dirs (starting with .)
      if (dirent.name.startsWith('.')) continue;

      const fullPath = path.join(resolved, dirent.name);
      const relativePath = path.relative(cwd, fullPath);

      let size = null;
      if (!dirent.isDirectory()) {
        try {
          const stats = await fsp.stat(fullPath);
          size = stats.size;
        } catch { /* skip unreadable files */ }
      }

      entries.push({
        name: dirent.name,
        relativePath,
        isDirectory: dirent.isDirectory(),
        size
      });
    }

    // Sort: directories first, then files, alphabetical within each group
    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    res.json({ path: reqPath, entries });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Directory not found' });
    if (err.code === 'ENOTDIR') return res.status(400).json({ error: 'Not a directory' });
    console.error('[FileAPI] readdir error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/file - Read file content
app.get('/api/file', async (req, res) => {
  if (!authenticateRequest(req, res)) return;
  if (!checkFileApiRate(req, res)) return;

  const { sessionId, path: reqPath } = req.query;
  if (!validateSessionId(sessionId, res)) return;
  if (!reqPath) return res.status(400).json({ error: 'path required' });

  const cwd = await resolveSessionCwd(sessionId, res);
  if (!cwd) return;

  const resolved = await validatePath(cwd, reqPath, res);
  if (!resolved) return;

  try {
    const stats = await fsp.stat(resolved);

    // Reject files over 1MB
    if (stats.size > MAX_READ_SIZE) {
      return res.json({ path: reqPath, error: 'File too large', size: stats.size });
    }

    // Read raw bytes for binary detection
    const buffer = await fsp.readFile(resolved);
    let content;
    try {
      // TextDecoder with fatal: true throws on invalid UTF-8
      const decoder = new TextDecoder('utf-8', { fatal: true });
      content = decoder.decode(buffer);
    } catch {
      return res.json({ path: reqPath, error: 'Binary file', size: stats.size });
    }

    const ext = path.extname(resolved).toLowerCase();
    const language = EXTENSION_TO_LANGUAGE[ext] || null;

    res.json({ path: reqPath, content, language, size: stats.size });
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'File not found' });
    if (err.code === 'EISDIR') return res.status(400).json({ error: 'Path is a directory' });
    console.error('[FileAPI] readFile error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// Slash Command Discovery
// ============================================

/**
 * Parse YAML frontmatter from a markdown file.
 * Returns an object with name, description, etc.
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;
  const result = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.substring(0, idx).trim();
    const value = line.substring(idx + 1).trim().replace(/^["']|["']$/g, '');
    result[key] = value;
  }
  return result;
}

/**
 * Scan a commands directory for .md files and return command entries.
 * Handles nested directories for namespaced commands (e.g., workflows/plan.md → workflows:plan).
 */
async function scanCommandsDir(dir, prefix = '') {
  const commands = [];
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Recurse into subdirectories with namespace prefix
        const nested = await scanCommandsDir(fullPath, entry.name);
        commands.push(...nested);
      } else if (entry.name.endsWith('.md')) {
        try {
          const content = await fsp.readFile(fullPath, 'utf8');
          const fm = parseFrontmatter(content);
          if (fm && fm.name) {
            commands.push({
              name: prefix ? `${prefix}:${fm.name.replace(`${prefix}:`, '')}` : fm.name,
              description: fm.description || ''
            });
          }
        } catch { /* skip unreadable files */ }
      }
    }
  } catch { /* directory doesn't exist */ }
  return commands;
}

/**
 * Discover all available slash commands from:
 * 1. Built-in Claude Code commands
 * 2. User-global commands (~/.claude/commands/)
 * 3. Project-local commands (.claude/commands/)
 * 4. Installed plugin commands
 */
async function discoverCommands() {
  const commands = [];
  const seen = new Set();

  function addCommand(cmd) {
    const key = cmd.name.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    commands.push(cmd);
  }

  // 1. Built-in commands
  const builtins = [
    { name: 'help', description: 'Show help and available commands' },
    { name: 'clear', description: 'Clear conversation history' },
    { name: 'compact', description: 'Compact conversation to save context' },
    { name: 'config', description: 'Open configuration' },
    { name: 'cost', description: 'Show token usage and cost' },
    { name: 'doctor', description: 'Check Claude Code installation health' },
    { name: 'init', description: 'Initialize project with CLAUDE.md' },
    { name: 'login', description: 'Switch accounts or re-authenticate' },
    { name: 'logout', description: 'Sign out of Claude Code' },
    { name: 'memory', description: 'Edit CLAUDE.md memory files' },
    { name: 'model', description: 'Switch AI model' },
    { name: 'permissions', description: 'View and manage tool permissions' },
    { name: 'review', description: 'Review a pull request' },
    { name: 'status', description: 'Show current session status' },
    { name: 'terminal-setup', description: 'Set up terminal integration' },
    { name: 'vim', description: 'Toggle vim keybindings' },
  ];
  for (const cmd of builtins) addCommand(cmd);

  // 2. User-global commands
  const userCommandsDir = path.join(os.homedir(), '.claude', 'commands');
  const userCmds = await scanCommandsDir(userCommandsDir);
  for (const cmd of userCmds) addCommand(cmd);

  // 3. Project-local commands (scan working directories of active sessions)
  const projectDirs = new Set();
  activeSessions.forEach((data) => {
    if (data.session?.cwd) projectDirs.add(data.session.cwd);
  });
  for (const dir of projectDirs) {
    const projectCommandsDir = path.join(dir, '.claude', 'commands');
    const projCmds = await scanCommandsDir(projectCommandsDir);
    for (const cmd of projCmds) addCommand(cmd);
  }

  // 4. Installed plugin commands and skills
  const pluginsFile = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
  try {
    const pluginsData = JSON.parse(await fsp.readFile(pluginsFile, 'utf8'));
    for (const [key, installs] of Object.entries(pluginsData.plugins || {})) {
      for (const install of installs) {
        if (!install.installPath) continue;
        // Scan commands/ directory
        const pluginCommandsDir = path.join(install.installPath, 'commands');
        const pluginCmds = await scanCommandsDir(pluginCommandsDir);
        for (const cmd of pluginCmds) addCommand(cmd);
        // Scan skills/ directory (skills use SKILL.md in subdirectories)
        const pluginSkillsDir = path.join(install.installPath, 'skills');
        try {
          const skillEntries = await fsp.readdir(pluginSkillsDir, { withFileTypes: true });
          for (const entry of skillEntries) {
            if (!entry.isDirectory()) continue;
            const skillFile = path.join(pluginSkillsDir, entry.name, 'SKILL.md');
            try {
              const content = await fsp.readFile(skillFile, 'utf8');
              const fm = parseFrontmatter(content);
              if (fm && fm.name) {
                addCommand({
                  name: fm.name,
                  description: fm.description || ''
                });
              }
            } catch { /* no SKILL.md or unreadable */ }
          }
        } catch { /* no skills directory */ }
      }
    }
  } catch { /* no plugins file */ }

  console.log(`[Commands] Discovered ${commands.length} slash commands`);
  return commands;
}

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
