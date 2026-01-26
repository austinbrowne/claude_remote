const express = require('express');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');
const os = require('os');
const chokidar = require('chokidar');

const app = express();
const PORT = process.env.PORT || 3456;
const AUTH_TOKEN = process.env.AUTH_TOKEN;
if (!AUTH_TOKEN || AUTH_TOKEN.length < 32) {
  console.error('ERROR: Set AUTH_TOKEN environment variable (minimum 32 characters)');
  console.error('Generate one with: openssl rand -hex 32');
  process.exit(1);
}
const MAX_READ_SIZE = 1024 * 1024; // 1MB max per read

// Create HTTP server for both Express and WebSocket
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
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

      // Get cwd for each process
      let pending = processes.length;
      const results = [];

      processes.forEach(proc => {
        exec(`lsof -a -p ${proc.pid} -d cwd 2>/dev/null | tail -1 | awk '{print $NF}'`, (err2, cwd) => {
          if (!err2 && cwd.trim()) {
            results.push({
              pid: proc.pid,
              tty: proc.tty,
              cwd: cwd.trim()
            });
          }
          pending--;
          if (pending === 0) resolve(results);
        });
      });
    });
  });
}

// Get iTerm tab names by TTY
function getITermTabNames() {
  return new Promise((resolve) => {
    const appleScript = `
      tell application "iTerm"
        set output to ""
        repeat with w in windows
          repeat with t in tabs of w
            set s to current session of t
            set sessionName to name of s
            set sessionTTY to tty of s
            set output to output & sessionName & "|" & sessionTTY & "\\n"
          end repeat
        end repeat
        return output
      end tell
    `;

    exec(`osascript -e '${appleScript.replace(/'/g, "'\"'\"'")}'`, (err, stdout) => {
      if (err) {
        resolve({});
        return;
      }

      const map = {};
      stdout.trim().split('\n').forEach(line => {
        if (!line.includes('|')) return;
        const [name, ttyPath] = line.split('|');
        const tty = ttyPath.replace('/dev/', '');
        // Clean up the name: remove (claude) suffix and sparkle prefix
        map[tty] = name.replace(/\s*\(claude\)\s*$/, '').replace(/^✳\s*/, '').trim();
      });
      resolve(map);
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
  if (fs.existsSync(CLAUDE_DIR)) {
    const projectDirs = fs.readdirSync(CLAUDE_DIR);
    for (const projectHash of projectDirs) {
      const projectDir = path.join(CLAUDE_DIR, projectHash);
      // Always scan JSONL files directly - sessions-index.json can be stale after `claude resume`
      try {
          const files = fs.readdirSync(projectDir);
          const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));

          for (const jsonlFile of jsonlFiles) {
            const fullPath = path.join(projectDir, jsonlFile);
            const sessionId = path.basename(jsonlFile, '.jsonl');
            const stats = fs.statSync(fullPath);

            // Read first 2KB to find cwd field
            const fd = fs.openSync(fullPath, 'r');
            const buffer = Buffer.alloc(2000);
            fs.readSync(fd, buffer, 0, 2000, 0);
            fs.closeSync(fd);

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
        } catch (e) {}
    }
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
      const entries = (project.indexData.entries || [])
        .filter(e => fs.existsSync(e.fullPath))
        .sort((a, b) => new Date(b.modified || b.fileMtime) - new Date(a.modified || a.fileMtime));

      if (entries.length > 0) {
        const entry = entries[0];
        logFile = entry.fullPath;
        sessionId = entry.sessionId;
        status = getSessionStatus(entry.fullPath);
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
    const stats = fs.statSync(session.logFile);
    lastPosition = stats.size;
  } catch (e) {
    // File might not exist yet
  }
  
  // Watch the log file for changes
  const watcher = chokidar.watch(session.logFile, {
    persistent: true,
    usePolling: false,  // Use native FSEvents on macOS
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 100
    }
  });
  
  watcher.on('change', (filePath) => {
    console.log(`[Watcher] File change detected: ${filePath}`);
    try {
      const stats = fs.statSync(filePath);
      if (stats.size > lastPosition) {
        const bytesToRead = Math.min(stats.size - lastPosition, MAX_READ_SIZE);
        const fd = fs.openSync(filePath, 'r');
        const buffer = Buffer.alloc(bytesToRead);
        fs.readSync(fd, buffer, 0, bytesToRead, lastPosition);
        fs.closeSync(fd);

        const newContent = buffer.toString('utf8');
        const lines = newContent.split('\n').filter(line => line.trim());

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
            // Skip invalid JSON lines
          }
        }

        lastPosition += bytesToRead;

        // Check and broadcast status changes
        const newStatus = getSessionStatus(filePath);
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
  
  activeSessions.set(sessionId, {
    watcher,
    logsDirWatcher,
    session,
    lastPosition,
    lastStatus: getSessionStatus(session.logFile)
  });
  
  console.log(`[Session] Now watching: ${session.name} -> ${session.logFile}`);
  
  return session;
}

function unwatchSession(sessionId) {
  if (activeSessions.has(sessionId)) {
    const { watcher, logsDirWatcher } = activeSessions.get(sessionId);
    watcher.close();
    logsDirWatcher?.close();
    activeSessions.delete(sessionId);
  }
}

function parseLogEntry(entry) {
  const results = [];
  const timestamp = entry.timestamp || new Date().toISOString();

  // Skip progress entries (they're just status updates)
  if (entry.type === 'progress') return null;

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
        // Tool use - Claude calling a tool
        else if (block.type === 'tool_use') {
          // Special handling for AskUserQuestion - emit as structured prompt
          if (block.name === 'AskUserQuestion' && block.input?.questions) {
            results.push({
              type: 'ask_user_question',
              questions: block.input.questions,
              timestamp
            });
          }
          // Permission-requiring tools - emit as permission_request
          else if (['Bash', 'Write', 'Edit', 'MultiEdit'].includes(block.name)) {
            console.log(`[Permission] Detected ${block.name} tool call`);
            results.push({
              type: 'permission_request',
              tool: block.name,
              input: block.input || {},
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

function getSessionStatus(logFile) {
  try {
    const stats = fs.statSync(logFile);
    if (stats.size === 0) return 'idle';

    // Read last 5KB to find last entry (avoid reading entire file)
    const fd = fs.openSync(logFile, 'r');
    const size = Math.min(stats.size, 5000);
    const buffer = Buffer.alloc(size);
    fs.readSync(fd, buffer, 0, size, stats.size - size);
    fs.closeSync(fd);

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

// ============================================
// WebSocket Handling
// ============================================

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token');
  
  if (token !== AUTH_TOKEN) {
    ws.close(4001, 'Unauthorized');
    return;
  }
  
  const clientId = Date.now().toString();
  clients.set(ws, { 
    id: clientId, 
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
  
  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);
      handleClientMessage(ws, msg);
    } catch (e) {
      console.error('WebSocket message error:', e);
    }
  });
  
  ws.on('close', () => {
    const clientData = clients.get(ws);
    if (clientData) {
      clientData.watchingSessions.forEach(sessionId => {
        let otherWatching = false;
        clients.forEach((otherData, otherWs) => {
          if (otherWs !== ws && otherData.watchingSessions.has(sessionId)) {
            otherWatching = true;
          }
        });
        if (!otherWatching) {
          unwatchSession(sessionId);
        }
      });
    }
    
    clients.delete(ws);
    console.log(`[Client] Disconnected: ${clientId}`);
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
        sendRecentHistory(ws, msg.sessionId);
      } else {
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Session not found or no log file'
        }));
      }
      break;
      
    case 'unwatch_session':
      clientData.watchingSessions.delete(msg.sessionId);
      let otherWatching = false;
      clients.forEach((otherData, otherWs) => {
        if (otherWs !== ws && otherData.watchingSessions.has(msg.sessionId)) {
          otherWatching = true;
        }
      });
      if (!otherWatching) {
        unwatchSession(msg.sessionId);
      }
      break;
      
    case 'refresh_sessions':
      discoverSessions().then(sessions => {
        ws.send(JSON.stringify({
          type: 'sessions',
          data: sessions
        }));
      });
      break;
      
    case 'inject':
      injectCommand(msg.command).then(() => {
        ws.send(JSON.stringify({ type: 'inject_result', success: true }));
      }).catch(err => {
        ws.send(JSON.stringify({ type: 'inject_result', success: false, error: err.message }));
      });
      break;
      
    case 'escape':
      sendEscapeKey().then(() => {
        ws.send(JSON.stringify({ type: 'escape_result', success: true }));
      }).catch(err => {
        ws.send(JSON.stringify({ type: 'escape_result', success: false, error: err.message }));
      });
      break;
      
    case 'update_settings':
      Object.assign(clientData.settings, msg.settings);
      break;

    case 'ping':
      ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
      break;
  }
}

function sendRecentHistory(ws, sessionId) {
  const sessionData = activeSessions.get(sessionId);
  if (!sessionData || !sessionData.session.logFile) return;
  
  try {
    if (!fs.existsSync(sessionData.session.logFile)) {
      ws.send(JSON.stringify({ type: 'history', sessionId, data: [] }));
      return;
    }
    
    const content = fs.readFileSync(sessionData.session.logFile, 'utf8');
    const lines = content.split('\n').filter(line => line.trim());
    const recentLines = lines.slice(-100);
    const history = [];
    
    for (const line of recentLines) {
      try {
        const entry = JSON.parse(line);
        const parsed = parseLogEntry(entry);
        if (parsed) {
          const items = Array.isArray(parsed) ? parsed : [parsed];
          history.push(...items);
        }
      } catch (e) {}
    }
    
    ws.send(JSON.stringify({ type: 'history', sessionId, data: history }));
  } catch (e) {
    console.error('Error reading history:', e);
  }
}

// ============================================
// Command Injection
// ============================================

function injectCommand(command) {
  // Use clipboard for reliable text injection
  return new Promise((resolve, reject) => {
    // First, copy to clipboard using pbcopy
    const pbcopy = exec('pbcopy', (error) => {
      if (error) {
        reject(new Error('Failed to copy to clipboard'));
        return;
      }

      // Then paste and press return
      const appleScript = `
        tell application "iTerm" to activate
        delay 0.15
        tell application "System Events" to tell process "iTerm2"
          keystroke "v" using command down
          delay 0.1
          keystroke return
        end tell
      `;

      exec(`osascript -e '${appleScript}'`, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr || err.message));
        } else {
          console.log(`[Inject] ${command.substring(0, 50)}${command.length > 50 ? '...' : ''}`);
          resolve();
        }
      });
    });

    pbcopy.stdin.write(command);
    pbcopy.stdin.end();
  });
}

function sendEscapeKey() {
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
        console.log('[Inject] Escape key');
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
