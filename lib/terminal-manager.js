const path = require('path');
const fsp = require('fs').promises;
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const TMUX_TIMEOUT = 5000;

// Rate limiting
const rateLimits = {
  newTerminal: new Map(),  // clientId → timestamps[]
  startClaude: new Map()   // clientId → lastTimestamp
};

/**
 * Check rate limit for new_terminal (max 5 per minute per client).
 * Returns true if allowed, false if rate-limited.
 */
function checkNewTerminalRate(clientId) {
  const now = Date.now();
  const timestamps = rateLimits.newTerminal.get(clientId) || [];
  const recent = timestamps.filter(t => now - t < 60000);
  if (recent.length >= 5) return false;
  recent.push(now);
  rateLimits.newTerminal.set(clientId, recent);
  return true;
}

/**
 * Check rate limit for start_claude (max 1 per 5 seconds per client).
 * Returns true if allowed, false if rate-limited.
 */
function checkStartClaudeRate(clientId) {
  const now = Date.now();
  const last = rateLimits.startClaude.get(clientId) || 0;
  if (now - last < 2000) return false;
  rateLimits.startClaude.set(clientId, now);
  return true;
}

/**
 * Create a new tmux window in the given session.
 * Creates the session if it doesn't exist.
 */
async function createWindow(sessionName, cwd) {
  // Check if session exists, create if not
  try {
    await execFileAsync('tmux', ['has-session', '-t', sessionName], { timeout: TMUX_TIMEOUT });
  } catch {
    // Start with a login shell so user profile (PATH, auth) is loaded
    await execFileAsync('tmux', [
      'new-session', '-d', '-s', sessionName, '-c', cwd,
      '/bin/zsh', '-l'
    ], { timeout: TMUX_TIMEOUT });
    return; // new-session already creates a window
  }

  // Start with a login shell so user profile (PATH, auth) is loaded
  await execFileAsync('tmux', [
    'new-window', '-t', sessionName, '-c', cwd,
    '/bin/zsh', '-l'
  ], { timeout: TMUX_TIMEOUT });
}

/**
 * List git repos in the configured REPOS_PATH.
 * Returns array of { name } objects (names only, never paths).
 */
async function listRepos() {
  const reposPath = process.env.REPOS_PATH;
  if (!reposPath) {
    return { error: 'REPOS_PATH not configured', repos: [] };
  }

  try {
    await fsp.access(reposPath);
  } catch {
    return { error: `REPOS_PATH directory not found: ${reposPath}`, repos: [] };
  }

  const entries = await fsp.readdir(reposPath, { withFileTypes: true });
  const repos = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    try {
      await fsp.access(path.join(reposPath, e.name, '.git'));
      repos.push({ name: e.name });
    } catch {
      // Not a git repo — skip
    }
  }
  return { error: null, repos };
}

/**
 * Resolve a repo name to a full path, validated against REPOS_PATH.
 * Returns the resolved path or null if invalid.
 */
function resolveRepoPath(repoName) {
  const reposPath = process.env.REPOS_PATH;
  if (!reposPath || !repoName) return null;

  // Reject path separators in repo name
  if (repoName.includes('/') || repoName.includes('\\') || repoName.includes('..')) return null;

  const resolved = path.resolve(reposPath, repoName);
  if (!resolved.startsWith(reposPath)) return null;

  return resolved;
}

/**
 * Watch for a Claude session to start in a given CWD.
 * Calls onReady when a JSONL file appears, or onTimeout after timeoutMs.
 */
function awaitClaudeStart(cwd, { onReady, onTimeout, timeoutMs = 10000 }) {
  const CLAUDE_DIR = path.join(process.env.HOME || '/tmp', '.claude', 'projects');
  const pollInterval = 1000;
  let elapsed = 0;

  const poll = setInterval(async () => {
    elapsed += pollInterval;

    if (elapsed >= timeoutMs) {
      clearInterval(poll);
      if (onTimeout) onTimeout();
      return;
    }

    // Check if any project dir has a recent JSONL matching this CWD
    try {
      const projectDirs = await fsp.readdir(CLAUDE_DIR);
      for (const dir of projectDirs) {
        const projectPath = path.join(CLAUDE_DIR, dir);
        const files = await fsp.readdir(projectPath);
        const jsonlFiles = files.filter(f => f.endsWith('.jsonl'));

        for (const jsonlFile of jsonlFiles) {
          const fullPath = path.join(projectPath, jsonlFile);
          const stats = await fsp.stat(fullPath);

          // Only check files modified in the last 15 seconds
          if (Date.now() - stats.mtime.getTime() > 15000) continue;

          // Read first 2KB to check CWD
          const fh = await fsp.open(fullPath, 'r');
          const buffer = Buffer.alloc(2000);
          try {
            await fh.read(buffer, 0, 2000, 0);
          } finally {
            await fh.close();
          }
          const content = buffer.toString('utf8');
          const cwdMatch = content.match(/"cwd":"([^"]+)"/);

          if (cwdMatch && cwdMatch[1] === cwd) {
            clearInterval(poll);
            if (onReady) onReady();
            return;
          }
        }
      }
    } catch {
      // Discovery failed — keep polling
    }
  }, pollInterval);

  return () => clearInterval(poll); // Cancel function
}

module.exports = {
  createWindow,
  listRepos,
  resolveRepoPath,
  awaitClaudeStart,
  checkNewTerminalRate,
  checkStartClaudeRate
};
