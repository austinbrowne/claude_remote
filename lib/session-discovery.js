const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');

// Claude projects directory
const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects');

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
  // Tools that Claude Code NEVER prompts the user for in any permission mode.
  // Only truly internal tools belong here — NOT read-only file/web tools like
  // Read, Glob, Grep, WebSearch, WebFetch. Those tools CAN require permission
  // depending on the user's Claude Code settings and permission mode. The watcher's
  // deferral mechanism handles auto-approved tools without false prompts.
  const allowed = new Set([
    // Internal / meta tools — Claude Code never gates these
    'TodoRead', 'TodoWrite',
    'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList',
    'EnterPlanMode', 'ExitPlanMode',
    'Skill', 'NotebookRead',
    // Agent management — never gated
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
          status = await getSessionStatus(logFile);
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
        // Check for tools that genuinely need user input
        const hasAskUser = content.some(block =>
          block.type === 'tool_use' && block.name === 'AskUserQuestion'
        );
        if (hasAskUser) return 'waiting';

        const hasExitPlan = content.some(block =>
          block.type === 'tool_use' && block.name === 'ExitPlanMode'
        );
        if (hasExitPlan) return 'waiting';

        // Check for pending tool_use without a tool_result
        const hasToolUse = content.some(block => block.type === 'tool_use');
        if (hasToolUse) {
          const lastToolUseId = content.find(b => b.type === 'tool_use')?.id;
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
          // Pending tool_use = tool is actively executing (processing),
          // NOT waiting for user input. Permission prompts are handled
          // separately by the prompt card system.
          if (!hasResult) return 'processing';
        }
      }
    }

    // Check if last entry is user type (assistant's turn to respond)
    // After a user message, Claude is processing the response
    if (entry.type === 'user') return 'processing';

    if (entry.type === 'progress') return 'processing';
    return 'active';
  } catch (e) {
    return 'unknown';
  }
}

module.exports = {
  CLAUDE_DIR,
  getActiveClaude,
  getGitBranch,
  loadAllowedTools,
  needsPermission,
  discoverSessions,
  getSessionStatus
};
