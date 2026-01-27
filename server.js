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
          await fh.read(buffer, 0, 2000, 0);
          await fh.close();

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

  // For each active Claude process, create an entry
  for (const proc of activeProcesses) {
    // Use directory name as stable identifier (Claude overwrites iTerm tab titles)
    const dirName = path.basename(proc.cwd) || `Session ${proc.tty}`;
    const project = cwdToProject[proc.cwd];

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
        const entry = entries[0];
        logFile = entry.fullPath;
        sessionId = entry.sessionId;
        status = await getSessionStatus(entry.fullPath);
        lastActive = entry.modified || new Date(entry.fileMtime).toISOString();
      }
    }

    sessions.push({
      id: sessionId,
      name: dirName,
      status: status,
      cwd: proc.cwd,
      lastActive: lastActive,
      logFile: logFile,
      tty: proc.tty,
      pid: proc.pid
    });
  }

  // Sort by tab name
  sessions.sort((a, b) => a.name.localeCompare(b.name));

  return sessions;
}

async function watchSession(sessionId) {
  const sessions = await discoverSessions();
  const session = sessions.find(s => s.id === sessionId);
  
  if (!session || !session.logFile) {
    return null;
  }
  
  // If already watching, return existing watcher
  if (activeSessions.has(sessionId)) {
    return activeSessions.get(sessionId).session;
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
    binaryInterval: 500,
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 100
    }
  });
  
  watcher.on('change', async (filePath) => {
    console.log(`[Watcher] File change detected: ${filePath}`);
    try {
      const stats = await fsp.stat(filePath);

      // Handle file truncation/rotation (e.g., log file cleared)
      if (stats.size < lastPosition) {
        console.log(`[Watcher] File truncated, resetting position from ${lastPosition} to 0`);
        lastPosition = 0;
      }

      if (stats.size > lastPosition) {
        const bytesToRead = Math.min(stats.size - lastPosition, MAX_READ_SIZE);
        const fh = await fsp.open(filePath, 'r');
        const buffer = Buffer.alloc(bytesToRead);
        await fh.read(buffer, 0, bytesToRead, lastPosition);
        await fh.close();

        const newContent = buffer.toString('utf8');

        // Only process complete lines (handle partial final line)
        const lastNewlineIndex = newContent.lastIndexOf('\n');
        if (lastNewlineIndex === -1) {
          // No complete lines yet, wait for more data
          return;
        }

        const completeContent = newContent.substring(0, lastNewlineIndex);
        const lines = completeContent.split('\n').filter(line => line.trim());

        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            const parsed = parseLogEntry(entry);
            if (parsed) {
              // Handle single result or array of results
              const items = Array.isArray(parsed) ? parsed : [parsed];
              for (const item of items) {
                console.log(`[Broadcast] ${item.type} to session ${sessionId.substring(0, 8)}`);
                broadcastToClients({
                  type: 'claude_output',
                  sessionId: sessionId,
                  data: item
                });
              }
            }
          } catch (e) {
            // Skip invalid JSON lines (log for debugging)
            console.debug(`[Watcher] Skipped invalid JSON: ${e.message}`);
          }
        }

        // Only advance position to end of last complete line
        lastPosition += lastNewlineIndex + 1;

        // Check and broadcast status changes
        const newStatus = await getSessionStatus(filePath);
        const sessionData = activeSessions.get(sessionId);
        if (sessionData && newStatus !== sessionData.lastStatus) {
          sessionData.lastStatus = newStatus;
          broadcastToClients({
            type: 'session_status',
            sessionId: sessionId,
            status: newStatus
          });
        }

        // If more data remains, schedule another read
        if (stats.size > lastPosition) {
          setImmediate(() => watcher.emit('change', filePath));
        }
      }
    } catch (e) {
      console.error('Error reading log file:', e);
    }
  });
  
  // Also watch for new log files in the logs directory
  const logsDir = path.dirname(session.logFile);
  const logsDirWatcher = chokidar.watch(logsDir, {
    persistent: true,
    ignoreInitial: true
  });
  
  logsDirWatcher.on('add', (newFile) => {
    if (newFile.endsWith('.jsonl')) {
      // Switch to watching the new file
      watcher.unwatch(session.logFile);
      session.logFile = newFile;
      lastPosition = 0;
      watcher.add(newFile);
      console.log(`[Session ${sessionId.substring(0, 8)}] Switched to new log file`);
    }
  });
  
  const initialStatus = await getSessionStatus(session.logFile);

  // Fallback polling interval - check file every 2 seconds in case watcher misses events
  const pollInterval = setInterval(() => {
    watcher.emit('change', session.logFile);
  }, 2000);

  activeSessions.set(sessionId, {
    watcher,
    logsDirWatcher,
    pollInterval,
    session,
    lastPosition,
    lastStatus: initialStatus,
    subagentWatchers: new Map(),  // Track subagent file watchers
    subagentPositions: new Map(), // Track read positions per subagent
    subagentTimeouts: new Map()   // Track inactivity timeouts per subagent
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
  fsp.access(subagentsDir).then(() => {
    // Don't scan existing files - they're old/completed subagents
    // Only watch for NEW subagent files created while we're connected

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

  // Initialize read position - ALWAYS start from end
  // Subagent history isn't useful - we only want live permissions waiting for input
  let lastPosition = 0;
  try {
    const stats = await fsp.stat(logFile);
    lastPosition = stats.size; // Start from end, only process new content
  } catch (e) {
    // File might not exist yet
  }
  sessionData.subagentPositions.set(agentId, lastPosition);

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

  // Broadcast subagent start with correlated description
  broadcastToClients({
    type: 'subagent_start',
    sessionId,
    agentId,
    description: description || agentId.substring(0, 8),
    agentType: agentType || 'general',
    timestamp: Date.now()
  });

  // Set up file watcher
  const watcher = chokidar.watch(logFile, {
    persistent: true,
    usePolling: true,
    interval: 500,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 }
  });

  watcher.on('change', async (filePath) => {
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
        await fh.read(buffer, 0, bytesToRead, position);
        await fh.close();

        const newContent = buffer.toString('utf8');
        const lastNewlineIndex = newContent.lastIndexOf('\n');
        if (lastNewlineIndex === -1) return;

        const completeContent = newContent.substring(0, lastNewlineIndex);
        const lines = completeContent.split('\n').filter(l => l.trim());

        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            const parsed = parseLogEntry(entry);
            if (parsed) {
              const items = Array.isArray(parsed) ? parsed : [parsed];
              for (const item of items) {
                // Add subagent context to the item
                item.subagentId = agentId;
                console.log(`[Subagent ${agentId}] ${item.type}`);
                broadcastToClients({
                  type: 'subagent_output',
                  sessionId,
                  agentId,
                  data: item
                });

                // Emit specific events for tool usage and token tracking
                if (item.type === 'tool' || item.type === 'permission_request') {
                  broadcastToClients({
                    type: 'subagent_tool',
                    sessionId,
                    agentId,
                    tool: item.tool,
                    input: item.input
                  });
                }
                if (item.type === 'token_usage') {
                  broadcastToClients({
                    type: 'subagent_tokens',
                    sessionId,
                    agentId,
                    input: item.input,
                    output: item.output
                  });
                }
              }
            }
          } catch (e) {
            // Skip invalid JSON
          }
        }

        sessionData.subagentPositions.set(agentId, position + lastNewlineIndex + 1);

        // Reset idle timeout
        resetSubagentIdleTimeout(sessionId, agentId);
      }
    } catch (e) {
      console.error(`[Subagent ${agentId}] Error:`, e.message);
    }
  });

  // No initial read - we start from end of file, only want live content

  sessionData.subagentWatchers.set(agentId, watcher);

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

function stopSubagent(sessionId, agentId) {
  const sessionData = activeSessions.get(sessionId);
  if (!sessionData) return;

  const watcher = sessionData.subagentWatchers.get(agentId);
  if (watcher) {
    watcher.close();
    sessionData.subagentWatchers.delete(agentId);
    sessionData.subagentPositions.delete(agentId);

    const timeout = sessionData.subagentTimeouts.get(agentId);
    if (timeout) {
      clearTimeout(timeout);
      sessionData.subagentTimeouts.delete(agentId);
    }

    console.log(`[Subagent ${agentId}] Stopped (idle timeout)`);

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
      text: `${getRandomSpinnerVerb()}...`,
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
            text: `${getRandomSpinnerVerb()}...`,
            timestamp
          });
        }
        // Tool use - Claude calling a tool
        else if (block.type === 'tool_use') {
          // Emit status update with random spinner verb (like terminal)
          results.push({
            type: 'status_update',
            text: `${getRandomSpinnerVerb()}...`,
            tool: block.name,
            timestamp
          });

          // Special handling for AskUserQuestion - emit as structured prompt
          if (block.name === 'AskUserQuestion' && block.input?.questions) {
            results.push({
              type: 'ask_user_question',
              questions: block.input.questions,
              timestamp
            });
          }
          // Permission-requiring tools - emit as permission_request
          const PERMISSION_TOOLS = ['Bash', 'Write', 'Edit', 'MultiEdit', 'WebFetch', 'NotebookEdit'];
          const isMcpTool = block.name && block.name.startsWith('mcp__');

          if (PERMISSION_TOOLS.includes(block.name) || isMcpTool) {
            console.log(`[Permission] Detected ${block.name} tool call`);
            results.push({
              type: 'permission_request',
              tool: isMcpTool ? formatMcpToolName(block.name) : block.name,
              input: isMcpTool ? sanitizeMcpInput(block.input) : (block.input || {}),
              timestamp
            });
          }
          // Task management tools - emit for task tracking
          else if (block.name === 'TaskCreate') {
            results.push({
              type: 'task_create',
              id: 'pending-' + Date.now(),
              subject: block.input?.subject,
              description: block.input?.description,
              activeForm: block.input?.activeForm,
              status: 'pending'
            });
          }
          else if (block.name === 'TaskUpdate') {
            results.push({
              type: 'task_update',
              id: block.input?.taskId,
              status: block.input?.status,
              subject: block.input?.subject
            });
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
    if (entry.message?.usage) {
      results.push({
        type: 'token_usage',
        input: entry.message.usage.input_tokens || 0,
        output: entry.message.usage.output_tokens || 0,
        cacheRead: entry.message.usage.cache_read_input_tokens || 0,
        cacheWrite: entry.message.usage.cache_creation_input_tokens || 0,
        timestamp
      });
    }
  }

  // User messages - could be human input or tool results
  if (entry.type === 'user') {
    // Tool result - always emit when toolUseResult exists (even if no output)
    // This signals the tool completed, which is needed to dismiss permission cards
    if (entry.toolUseResult) {
      const result = entry.toolUseResult.stdout || entry.toolUseResult.stderr || '';
      results.push({
        type: 'tool_result',
        result: result.trim() || '(completed)',
        isError: !!entry.toolUseResult.stderr && !entry.toolUseResult.stdout,
        timestamp
      });
    }
    // Human input
    else if (entry.message?.content) {
      const content = entry.message.content;
      if (typeof content === 'string') {
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

    // Read last 5KB to find last entry (avoid reading entire file)
    const fh = await fsp.open(logFile, 'r');
    const size = Math.min(stats.size, 5000);
    const buffer = Buffer.alloc(size);
    await fh.read(buffer, 0, size, stats.size - size);
    await fh.close();

    const lines = buffer.toString('utf8').split('\n').filter(l => l.trim());
    if (lines.length === 0) return 'idle';

    // Parse last complete line
    const lastLine = lines[lines.length - 1];
    const entry = JSON.parse(lastLine);

    if (entry.type === 'assistant') return 'waiting';
    if (entry.type === 'progress') return 'processing';
    return 'active';
  } catch (e) {
    return 'unknown';
  }
}

function broadcastToClients(message) {
  const data = JSON.stringify(message);
  clients.forEach((clientData, ws) => {
    if (ws.readyState === WebSocket.OPEN) {
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
  // Support both URL-based auth (legacy) and message-based auth (preferred)
  const url = new URL(req.url, `http://${req.headers.host}`);
  const urlToken = url.searchParams.get('token');

  const clientId = Date.now().toString();
  let authenticated = false;

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

  // If token provided in URL (legacy), authenticate immediately
  if (urlToken && secureCompare(urlToken, AUTH_TOKEN)) {
    authenticated = true;
    initializeClient();
  }

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
          ws.send(JSON.stringify({ type: 'auth_result', success: false, error: 'Invalid token' }));
          ws.close(4001, 'Unauthorized');
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

  switch (msg.action) {
    case 'watch_session':
      const session = await watchSession(msg.sessionId);
      if (session) {
        clientData.watchingSessions.add(msg.sessionId);
        ws.send(JSON.stringify({
          type: 'watching',
          sessionId: msg.sessionId,
          session: session
        }));
        await sendRecentHistory(ws, msg.sessionId);
      } else {
        sendError(ws, ErrorCodes.SESSION_NOT_FOUND, 'Session not found or no log file', { sessionId: msg.sessionId });
      }
      break;
      
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
      // Get TTY from session for targeted injection (works on background tabs)
      const injectSessionData = msg.sessionId ? activeSessions.get(msg.sessionId) : null;
      const injectTty = injectSessionData?.session?.tty;

      if (injectTty) {
        injectCommandToTty(msg.command, injectTty).then(() => {
          ws.send(JSON.stringify({ type: 'inject_result', success: true }));
        }).catch(err => {
          // Fallback to legacy if TTY injection fails
          console.log(`[Inject] TTY injection failed, trying legacy: ${err.message}`);
          injectCommandLegacy(msg.command).then(() => {
            ws.send(JSON.stringify({ type: 'inject_result', success: true }));
          }).catch(legacyErr => {
            ws.send(JSON.stringify({ type: 'inject_result', success: false, code: ErrorCodes.INJECT_FAILED, error: legacyErr.message }));
          });
        });
      } else {
        // No TTY available, use legacy injection
        injectCommandLegacy(msg.command).then(() => {
          ws.send(JSON.stringify({ type: 'inject_result', success: true }));
        }).catch(err => {
          ws.send(JSON.stringify({ type: 'inject_result', success: false, code: ErrorCodes.INJECT_FAILED, error: err.message }));
        });
      }
      break;

    case 'escape':
      // Get TTY from session for targeted escape (works on background tabs)
      const escapeSessionData = msg.sessionId ? activeSessions.get(msg.sessionId) : null;
      const escapeTty = escapeSessionData?.session?.tty;

      if (escapeTty) {
        sendEscapeKeyToTty(escapeTty).then(() => {
          ws.send(JSON.stringify({ type: 'escape_result', success: true }));
        }).catch(err => {
          // Fallback to legacy
          sendEscapeKeyLegacy().then(() => {
            ws.send(JSON.stringify({ type: 'escape_result', success: true }));
          }).catch(legacyErr => {
            ws.send(JSON.stringify({ type: 'escape_result', success: false, error: legacyErr.message }));
          });
        });
      } else {
        sendEscapeKeyLegacy().then(() => {
          ws.send(JSON.stringify({ type: 'escape_result', success: true }));
        }).catch(err => {
          ws.send(JSON.stringify({ type: 'escape_result', success: false, error: err.message }));
        });
      }
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
    const recentLines = lines.slice(-HISTORY_LINE_LIMIT);
    const history = [];

    for (const line of recentLines) {
      try {
        const entry = JSON.parse(line);
        const parsed = parseLogEntry(entry);
        if (parsed) {
          const items = Array.isArray(parsed) ? parsed : [parsed];
          history.push(...items);
        }
      } catch (e) {
        // Skip invalid JSON lines in history (expected for partial writes)
      }
    }

    ws.send(JSON.stringify({ type: 'history', sessionId, data: history }));
  } catch (e) {
    console.error('Error reading history:', e);
    ws.send(JSON.stringify({ type: 'history', sessionId, data: [], error: 'Failed to read history' }));
  }
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

  return new Promise((resolve, reject) => {
    // Escape the command for AppleScript string
    const escaped = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
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
  if (token !== AUTH_TOKEN) {
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

  // Close all file watchers
  activeSessions.forEach((data, sessionId) => {
    data.watcher.close();
    data.logsDirWatcher?.close();
  });
  activeSessions.clear();

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
║  Token:      ${AUTH_TOKEN.substring(0, 10)}...                            ║
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
