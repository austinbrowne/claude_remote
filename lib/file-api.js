const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;

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
function authenticateRequest(req, res, { secureCompare, AUTH_TOKEN }) {
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
async function resolveSessionCwd(sessionId, res, { activeSessions, discoverSessions }) {
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
    if (res) res.status(403).json({ error: 'Path traversal denied' });
    return null;
  }
  // Resolve symlinks to prevent escaping cwd via symlink targets
  try {
    const realCwd = await fsp.realpath(cwd);
    const realResolved = await fsp.realpath(resolved);
    if (!realResolved.startsWith(realCwd + path.sep) && realResolved !== realCwd) {
      if (res) res.status(403).json({ error: 'Path traversal denied' });
      return null;
    }
  } catch (err) {
    // On any realpath error, deny access since we cannot verify the resolved path
    if (res) res.status(403).json({ error: 'Path traversal denied' });
    return null;
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

/**
 * Create an Express Router for the file browsing API.
 * @param {Object} deps
 * @param {Map} deps.activeSessions
 * @param {Function} deps.discoverSessions
 * @param {Function} deps.secureCompare
 * @param {string} deps.AUTH_TOKEN
 * @param {number} deps.MAX_READ_SIZE
 */
function createFileApiRouter(deps) {
  const router = express.Router();
  const { MAX_READ_SIZE } = deps;

  // GET /api/files - List directory contents
  router.get('/api/files', async (req, res) => {
    if (!authenticateRequest(req, res, deps)) return;
    if (!checkFileApiRate(req, res)) return;

    const { sessionId, path: reqPath = '.' } = req.query;
    if (!validateSessionId(sessionId, res)) return;

    const cwd = await resolveSessionCwd(sessionId, res, deps);
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
  router.get('/api/file', async (req, res) => {
    if (!authenticateRequest(req, res, deps)) return;
    if (!checkFileApiRate(req, res)) return;

    const { sessionId, path: reqPath } = req.query;
    if (!validateSessionId(sessionId, res)) return;
    if (!reqPath) return res.status(400).json({ error: 'path required' });

    const cwd = await resolveSessionCwd(sessionId, res, deps);
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

  return router;
}

module.exports = {
  EXCLUDED_DIRS,
  EXTENSION_TO_LANGUAGE,
  validatePath,
  validateSessionId,
  createFileApiRouter
};
