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

              const parsed = parseLogEntry(entry);
              if (parsed) {
                linesProcessed = true;
                const items = Array.isArray(parsed) ? parsed : [parsed];
                allItems.push(...items);
              }
            } catch (e) {
              console.debug(`[Watcher] Skipped invalid JSON: ${e.message}`);
            }
          }

          // Suppress permission_requests that have a matching tool_result in the
          // same batch — these were auto-approved (Always Allow) and need no user input
          const resolvedToolUseIds = new Set(
            allItems
              .filter(i => i.type === 'tool_result' && i.toolUseId)
              .map(i => i.toolUseId)
          );
          const filteredItems = allItems.filter(item => {
            if (item.type === 'permission_request' && item.toolUseId && resolvedToolUseIds.has(item.toolUseId)) {
              return false;
            }
            return true;
          });

          for (const item of filteredItems) {
            if (item.type === 'token_usage') {
              // Store latest input_tokens as context usage (each API call includes full conversation)
              const sd = activeSessions.get(sessionId);
              if (sd && item.input) sd.contextTokensUsed = item.input;
              broadcastToClients({
                type: 'token_usage',
                sessionId: sessionId,
                input: item.input,
                output: item.output
              });
            } else if (item.type === 'mode_change') {
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
            } else {
              broadcastToClients({
                type: 'claude_output',
                sessionId: sessionId,
                data: item
              });
            }
          }

          lastPosition += consumedBytes;

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
    }
  });

  // Fallback poll: catches missed chokidar events. macOS FSEvents and polling
  // can both miss rapid writes. Ensures output never silently stops updating.
  const FALLBACK_POLL_MS = 2000;
  const fallbackPoll = setInterval(() => processLogChanges(), FALLBACK_POLL_MS);
  
  const initialStatus = await getSessionStatus(session.logFile);

  activeSessions.set(sessionId, {
    watcher,
    logsDirWatcher,
    pollInterval: fallbackPoll,
    session,
    lastPosition,
    lastStatus: initialStatus,
    mode: 'default',             // Current permission mode (updated from JSONL)
    contextTokensUsed: 0,        // Latest input_tokens from main session (= context window usage)
    subagentWatchers: new Map(),  // Track subagent file watchers
    subagentPositions: new Map(), // Track read positions per subagent
    subagentTimeouts: new Map(),  // Track inactivity timeouts per subagent
    subagentInfo: new Map()       // Track subagent metadata for sync to new clients
  });

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
  const now = Date.now();
  for (const [timestamp, info] of pendingSubagentDescriptions) {
    if (now - timestamp < 10000) { // Within 10 seconds
      description = info.description;
      agentType = info.type;
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
    currentTool: null
  };
  sessionData.subagentInfo.set(agentId, subagentData);

  broadcastToClients({
    type: 'subagent_start',
    sessionId,
    agentId,
    description: subagentData.description,
    agentType: subagentData.agentType,
    timestamp: subagentData.startTime
  });

  // Set up file watcher
  const watcher = chokidar.watch(logFile, {
    persistent: true,
    usePolling: true,
    interval: 500,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 }
  });

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
            const parsed = parseLogEntry(entry);
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

        // Suppress permission_requests that have a matching tool_result in the
        // same batch — these were auto-approved (Always Allow) and need no user input
        const resolvedToolUseIds = new Set(
          allItems
            .filter(i => i.type === 'tool_result' && i.toolUseId)
            .map(i => i.toolUseId)
        );

        for (const item of allItems) {
          if (item.type === 'permission_request' && item.toolUseId && resolvedToolUseIds.has(item.toolUseId)) {
            continue; // Auto-approved, skip
          }

          console.log(`[Subagent ${agentId}] ${item.type}`);
          broadcastToClients({
            type: 'subagent_output',
            sessionId,
            agentId,
            data: item
          });

          // Emit specific events for tool usage and token tracking
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

function parseLogEntry(entry) {
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

          const PERMISSION_TOOLS = ['Bash', 'Write', 'Edit', 'MultiEdit', 'WebFetch', 'NotebookEdit'];
          const isMcpTool = block.name && block.name.startsWith('mcp__');

          // Special handling for AskUserQuestion - emit as structured prompt
          if (block.name === 'AskUserQuestion' && block.input?.questions) {
            results.push({
              type: 'ask_user_question',
              questions: block.input.questions,
              timestamp
            });
          }
          // Permission-requiring tools - emit as permission_request
          else if (PERMISSION_TOOLS.includes(block.name) || isMcpTool) {
            console.log(`[Permission] Detected ${block.name} tool call`);
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
            results.push({
              type: 'task_create',
              id: pendingId,
              subject: block.input?.subject,
              description: block.input?.description,
              activeForm: block.input?.activeForm,
              status: 'pending'
            });
          }
          else if (block.name === 'TaskUpdate') {
            const realId = String(block.input?.taskId ?? '');
            const mappedId = taskIdMap.get(realId) || realId;
            results.push({
              type: 'task_update',
              taskId: mappedId,
              status: block.input?.status,
              subject: block.input?.subject,
              description: block.input?.description,
              activeForm: block.input?.activeForm
            });
          }
          else if (block.name === 'EnterPlanMode') {
            results.push({ type: 'mode_change', mode: 'plan', timestamp });
          }
          else if (block.name === 'ExitPlanMode') {
            results.push({ type: 'mode_change', mode: 'default', timestamp });
          }
          else if (block.name === 'Task') {
            // Subagent being spawned - track description for correlation
            const agentDescription = block.input?.description || 'Subagent';
            const agentType = block.input?.subagent_type || 'general';
            pendingSubagentDescriptions.set(Date.now(), {
              description: agentDescription,
              type: agentType
            });
            results.push({
              type: 'subagent_starting',
              content: agentDescription,
              tool: agentType,
              description: agentDescription,
              agentType: agentType,
              timestamp
            });
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

    // Extract token usage from assistant messages
    // Total context = input_tokens + cached tokens (cache is still part of the context window)
    if (entry.message?.usage) {
      const u = entry.message.usage;
      const totalInput = (u.input_tokens || 0)
        + (u.cache_read_input_tokens || 0)
        + (u.cache_creation_input_tokens || 0);
      results.push({
        type: 'token_usage',
        input: totalInput,
        output: u.output_tokens || 0,
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
        const result = entry.toolUseResult.stdout || entry.toolUseResult.stderr || '';
        // TaskCreate result text contains "Created task N: ..." or "id: N"
        const idMatch = result.match(/(?:task\s+#?|id[:\s]+)(\d+)/i);
        if (idMatch) {
          taskIdMap.set(idMatch[1], pendingId);
        }
        pendingTaskIds.delete(toolUseId);
      }

      const result = entry.toolUseResult.stdout || entry.toolUseResult.stderr || '';
      results.push({
        type: 'tool_result',
        content: result.trim() || '(completed)',
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
        // Skip command invocation wrappers (e.g. <command-message>commit</command-message>)
        if (content.includes('<command-message>') || content.includes('<command-name>')) {
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

function broadcastToClients(message) {
  // Log subagent-related messages for debugging
  if (message.type?.startsWith('subagent')) {
    console.log(`[BROADCAST] ${message.type} agentId=${message.agentId} dataType=${message.data?.type}`);
  }
  const data = JSON.stringify(message);
  clients.forEach((clientData, ws) => {
    if (ws.readyState === WebSocket.OPEN && !clientData.pauseBroadcast) {
      if (!message.sessionId || clientData.watchingSessions.has(message.sessionId)) {
        ws.send(data);
      }
    }
  });
}

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
          await sendRecentHistory(ws, msg.sessionId);
          await sendActiveSubagents(ws, msg.sessionId);
          // Send accumulated context usage so the ring starts at the right value
          if (sessionData?.contextTokensUsed > 0) {
            ws.send(JSON.stringify({
              type: 'token_usage',
              sessionId: msg.sessionId,
              input: sessionData.contextTokensUsed,
              output: 0
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

    // Scan ALL lines for the last token_usage (context window = latest total input tokens).
    // Must scan all lines because recent history may be tool calls with no assistant message.
    let lastContextTokens = 0;
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.message?.usage) {
          const u = entry.message.usage;
          lastContextTokens = (u.input_tokens || 0)
            + (u.cache_read_input_tokens || 0)
            + (u.cache_creation_input_tokens || 0);
        }
      } catch (e) {}
    }
    if (lastContextTokens > 0 && sessionData) {
      sessionData.contextTokensUsed = lastContextTokens;
    }

    const recentLines = lines.slice(-HISTORY_LINE_LIMIT);
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

        const parsed = parseLogEntry(entry);
        if (parsed) {
          const items = Array.isArray(parsed) ? parsed : [parsed];
          allItems.push(...items.filter(i => i.type !== 'token_usage' && i.type !== 'mode_change'));
        }
      } catch (e) {
        // Skip invalid JSON lines in history (expected for partial writes)
      }
    }

    // Suppress auto-approved permission_requests (same logic as live messages)
    const resolvedToolUseIds = new Set(
      allItems
        .filter(i => i.type === 'tool_result' && i.toolUseId)
        .map(i => i.toolUseId)
    );
    const history = allItems.filter(item => {
      if (item.type === 'permission_request' && item.toolUseId && resolvedToolUseIds.has(item.toolUseId)) {
        return false;
      }
      return true;
    });

    // Set initial mode from history and notify the client
    // sessionData already declared at top of function
    if (lastMode && sessionData) {
      sessionData.mode = lastMode;
      console.log(`[Mode] Session ${sessionId.substring(0, 8)} initial mode from history: ${lastMode}`);
    }

    console.log(`[HISTORY] Sending ${history.length} items for session ${sessionId.substring(0, 8)}`);
    ws.send(JSON.stringify({ type: 'history', sessionId, data: history }));

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
          const parsed = parseLogEntry(entry);
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
    // Write text without auto-newline, then explicitly send carriage return (ASCII 13) to submit
    const appleScript = `
      tell application "iTerm2"
        repeat with w in windows
          repeat with t in tabs of w
            repeat with s in sessions of t
              if tty of s is "${targetTty}" then
                tell s
                  write text "${escaped}" newline no
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
  const token = req.headers.authorization?.replace('Bearer ', '');
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

  // 4. Installed plugin commands
  const pluginsFile = path.join(os.homedir(), '.claude', 'plugins', 'installed_plugins.json');
  try {
    const pluginsData = JSON.parse(await fsp.readFile(pluginsFile, 'utf8'));
    for (const [key, installs] of Object.entries(pluginsData.plugins || {})) {
      for (const install of installs) {
        if (!install.installPath) continue;
        const pluginCommandsDir = path.join(install.installPath, 'commands');
        const pluginCmds = await scanCommandsDir(pluginCommandsDir);
        for (const cmd of pluginCmds) addCommand(cmd);
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
