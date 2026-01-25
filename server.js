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

function discoverSessions() {
  const sessions = [];
  
  if (!fs.existsSync(CLAUDE_DIR)) {
    return sessions;
  }

  const projectDirs = fs.readdirSync(CLAUDE_DIR);
  
  for (const projectHash of projectDirs) {
    const projectPath = path.join(CLAUDE_DIR, projectHash);
    const sessionFile = path.join(projectPath, '.session.json');
    const logsDir = path.join(projectPath, 'logs');
    
    if (fs.existsSync(sessionFile)) {
      try {
        const sessionData = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
        
        // Find the most recent log file
        let latestLog = null;
        if (fs.existsSync(logsDir)) {
          const logFiles = fs.readdirSync(logsDir)
            .filter(f => f.endsWith('.jsonl'))
            .sort()
            .reverse();
          
          if (logFiles.length > 0) {
            latestLog = path.join(logsDir, logFiles[0]);
          }
        }
        
        sessions.push({
          id: projectHash,
          name: sessionData.projectName || path.basename(sessionData.cwd || '') || projectHash.substring(0, 8),
          cwd: sessionData.cwd || 'Unknown',
          lastActive: sessionData.lastActive || fs.statSync(sessionFile).mtime,
          logFile: latestLog,
          sessionFile: sessionFile
        });
      } catch (e) {
        // Skip invalid session files
      }
    }
  }
  
  // Sort by most recently active
  sessions.sort((a, b) => new Date(b.lastActive) - new Date(a.lastActive));
  
  return sessions;
}

function watchSession(sessionId) {
  const sessions = discoverSessions();
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
              broadcastToClients({
                type: 'claude_output',
                sessionId: sessionId,
                data: parsed
              });
            }
          } catch (e) {
            // Skip invalid JSON lines
          }
        }

        lastPosition += bytesToRead;

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
    lastPosition
  });
  
  console.log(`[Session] Now watching: ${session.name}`);
  
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

function extractContent(entry) {
  if (typeof entry.content === 'string') {
    return entry.content;
  }
  if (Array.isArray(entry.content)) {
    return entry.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');
  }
  return entry.message || '';
}

function parseLogEntry(entry) {
  // Skip internal/system entries
  if (entry.type === 'system' && !entry.content) return null;

  // Assistant messages (Claude's responses)
  if (entry.type === 'assistant' || entry.role === 'assistant') {
    const content = extractContent(entry);
    if (!content) return null;

    return {
      type: 'assistant',
      content: content,
      timestamp: entry.timestamp || new Date().toISOString()
    };
  }

  // User messages
  if (entry.type === 'user' || entry.role === 'user') {
    const content = extractContent(entry);
    if (!content) return null;

    return {
      type: 'user',
      content: content,
      timestamp: entry.timestamp || new Date().toISOString()
    };
  }
  
  // Tool use
  if (entry.type === 'tool_use' || entry.tool) {
    return {
      type: 'tool',
      tool: entry.name || entry.tool || 'unknown',
      input: entry.input || entry.arguments || {},
      timestamp: entry.timestamp || new Date().toISOString()
    };
  }
  
  // Tool results
  if (entry.type === 'tool_result') {
    return {
      type: 'tool_result',
      toolUseId: entry.tool_use_id,
      result: entry.content || entry.result || entry.output || '',
      isError: entry.is_error || false,
      timestamp: entry.timestamp || new Date().toISOString()
    };
  }
  
  return null;
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
  ws.send(JSON.stringify({
    type: 'sessions',
    data: discoverSessions()
  }));
  
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

function handleClientMessage(ws, msg) {
  const clientData = clients.get(ws);
  
  switch (msg.action) {
    case 'watch_session':
      const session = watchSession(msg.sessionId);
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
      ws.send(JSON.stringify({
        type: 'sessions',
        data: discoverSessions()
      }));
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
        if (parsed) history.push(parsed);
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
  const escapedCommand = command
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');

  const appleScript = `
    tell application "Terminal"
      activate
      delay 0.2
      tell application "System Events"
        tell process "Terminal"
          keystroke "${escapedCommand}"
          delay 0.1
          keystroke return
        end tell
      end tell
    end tell
  `;

  return new Promise((resolve, reject) => {
    exec(`osascript -e '${appleScript.replace(/'/g, "'\"'\"'")}'`, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
      } else {
        console.log(`[Inject] ${command.substring(0, 50)}${command.length > 50 ? '...' : ''}`);
        resolve();
      }
    });
  });
}

function sendEscapeKey() {
  const appleScript = `
    tell application "Terminal"
      activate
      delay 0.2
      tell application "System Events"
        tell process "Terminal"
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
app.get('/health/detailed', (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (token !== AUTH_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json({
    status: 'ok',
    sessions: discoverSessions().length,
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

server.listen(PORT, () => {
  const sessions = discoverSessions();
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
║  Sessions: ${sessions.length.toString().padEnd(50)}║
${sessions.slice(0, 3).map(s => `║    • ${s.name.substring(0, 50).padEnd(53)}║`).join('\n')}
╚═══════════════════════════════════════════════════════════════╝
  `);
});
