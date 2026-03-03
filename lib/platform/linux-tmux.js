/**
 * Linux/tmux platform adapter.
 *
 * Session discovery via `tmux list-panes`.
 * Command injection via `tmux send-keys` using execFile (no shell interpolation).
 *
 * Security: All tmux calls use execFile with argument arrays — never exec with
 * string interpolation — to prevent shell injection. Text input uses the -l
 * (literal) flag to prevent tmux key-name interpretation.
 */
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const MAX_COMMAND_LENGTH = 4096;
const TMUX_EXEC_TIMEOUT_MS = 5000; // [CONS-002] Timeout for all tmux subprocess calls

// Map ASCII char codes to tmux key names
const CHAR_CODE_MAP = {
  3: 'C-c',
  4: 'C-d',
  12: 'C-l',
  21: 'C-u',
  26: 'C-z',
  27: 'Escape',
};

// [CONS-003] Per-pane promise queue to serialize injection sequences.
// Prevents interleaving when concurrent callers target the same pane.
const paneQueues = new Map();

function withPaneLock(paneId, fn) {
  const prev = paneQueues.get(paneId) || Promise.resolve();
  // Chain: wait for prev (ignoring its errors), then run fn
  const run = prev.catch(() => {}).then(fn);
  // Store continuation that absorbs errors so future tasks still chain
  paneQueues.set(paneId, run.catch(() => {}));
  // Return fn's actual result/rejection to the caller
  return run;
}

// --- Target validation ---

/**
 * Validate a tmux pane ID. Strict format: %N where N is one or more digits.
 * Returns null on success, Error on invalid format.
 */
function validateTarget(paneId) {
  if (!paneId || typeof paneId !== 'string' || !/^%\d+$/.test(paneId)) {
    return new Error('Invalid pane ID format');
  }
  return null;
}

// --- Helpers ---

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Run tmux send-keys. All arguments passed as array via execFile (no shell).
 * [CONS-002] Includes timeout to prevent hung tmux from blocking indefinitely.
 */
async function tmuxSendKeys(paneId, ...args) {
  const targetErr = validateTarget(paneId);
  if (targetErr) throw targetErr;

  try {
    await execFileAsync('tmux', ['send-keys', '-t', paneId, ...args], {
      timeout: TMUX_EXEC_TIMEOUT_MS,
    });
  } catch (err) {
    // tmux exits non-zero if pane doesn't exist
    if (err.stderr && err.stderr.includes('no such')) {
      throw new Error(`Pane ${paneId} not found (session may have ended)`);
    }
    // [CONS-006/SEC-003] Sanitize error — don't leak tmux internals to callers
    console.error(`[tmux] send-keys failed for ${paneId}: ${err.message}`);
    throw new Error('Command delivery failed');
  }
}

/**
 * Sanitize command text before injection.
 * Strips null bytes and control characters (preserves printable + tab/newline/CR).
 */
function sanitizeCommand(command) {
  if (typeof command !== 'string') {
    throw new Error('Command must be a string');
  }
  if (command.length > MAX_COMMAND_LENGTH) {
    throw new Error(`Command too long: ${command.length} chars (max ${MAX_COMMAND_LENGTH})`);
  }
  return command.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

// --- Session discovery ---

/**
 * Discover active Claude Code sessions running inside tmux panes.
 * Uses a single `tmux list-panes` call with structured format output.
 *
 * Returns [{pid, tty, cwd}] where the `tty` field carries the tmux pane ID (%N)
 * for compatibility with session-discovery.js's session object shape.
 * [CONS-008] Note: On Linux, `tty` is a pane ID (e.g., "%3"), not a TTY device path.
 */
async function getActiveProcesses() {
  try {
    const { stdout } = await execFileAsync('tmux', [
      'list-panes', '-a', '-F',
      '#{pane_id}|#{pane_pid}|#{pane_current_command}|#{pane_current_path}'
    ], { timeout: TMUX_EXEC_TIMEOUT_MS });

    if (!stdout.trim()) return [];

    const serverPane = process.env.TMUX_PANE;
    const results = [];

    for (const line of stdout.trim().split('\n')) {
      // [CONS-004] Split with limit of 4 — pane_current_path (last field) may contain '|'
      const parts = line.split('|');
      if (parts.length < 4) continue;

      const paneId = parts[0];
      const pid = parts[1];
      const currentCommand = parts[2];
      const currentPath = parts.slice(3).join('|'); // Rejoin in case path contains '|'

      // Skip the server's own pane
      if (serverPane && paneId === serverPane) continue;

      // Match panes running Claude Code
      if (currentCommand && /^claude(\s|$)/.test(currentCommand)) {
        results.push({
          pid,
          tty: paneId,
          cwd: currentPath,
        });
      }
    }

    return results;
  } catch (err) {
    // tmux not running or not installed
    if (err.code === 'ENOENT') {
      console.error('[Discovery] tmux not found. Install with: sudo dnf install tmux');
      return [];
    }
    if (err.stderr && (err.stderr.includes('no server running') || err.stderr.includes('no current client'))) {
      console.log('[Discovery] No tmux server running');
      return [];
    }
    console.error(`[Discovery] tmux error: ${err.message}`);
    return [];
  }
}

// --- Command injection ---

/**
 * Inject a command into a tmux pane.
 * Uses -l (literal) flag so tmux does not interpret key names in the text.
 * Enter is sent as a separate call (without -l) to submit.
 * [CONS-003] Wrapped in per-pane mutex to prevent interleaving.
 */
async function injectCommand(command, paneId) {
  const sanitized = sanitizeCommand(command);

  return withPaneLock(paneId, async () => {
    // Send text in literal mode (no key name interpretation)
    await tmuxSendKeys(paneId, '-l', sanitized);
    // Small delay for input processing
    await delay(10);
    // Submit with Enter (not literal — Enter is a key name)
    await tmuxSendKeys(paneId, 'Enter');

    console.log(`[Inject Pane ${paneId}] ${command.substring(0, 50)}${command.length > 50 ? '...' : ''}`);
  });
}

/**
 * Navigate an interactive selector by sending arrow-down keys then Enter.
 * [CONS-003] Wrapped in per-pane mutex to prevent interleaving.
 */
async function selectOption(index, paneId) {
  if (!Number.isInteger(index) || index < 0 || index > 50) {
    throw new Error('Invalid index: must be an integer between 0 and 50');
  }

  return withPaneLock(paneId, async () => {
    for (let i = 0; i < index; i++) {
      await tmuxSendKeys(paneId, 'Down');
      await delay(10);
    }
    await tmuxSendKeys(paneId, 'Enter');

    console.log(`[SelectOption Pane ${paneId}] index=${index}`);
  });
}

/**
 * Send a control character to a tmux pane.
 */
async function sendControlChar(charCode, paneId) {
  if (!Number.isInteger(charCode) || charCode < 0 || charCode > 127) {
    throw new Error('Invalid charCode: must be an integer between 0 and 127');
  }

  const keyName = CHAR_CODE_MAP[charCode];
  if (keyName) {
    await tmuxSendKeys(paneId, keyName);
  } else {
    // For unmapped codes, send the raw character via literal mode
    const char = String.fromCharCode(charCode);
    await tmuxSendKeys(paneId, '-l', char);
  }
}

/**
 * Send Escape key to a tmux pane.
 */
async function sendEscapeKey(paneId) {
  await tmuxSendKeys(paneId, 'Escape');
  console.log(`[Inject Pane ${paneId}] Escape key`);
}

/**
 * Prepare a session for command injection: cancel processing + clear input.
 * Delays reduced from macOS (1.5s+0.5s) since tmux send-keys is near-instant.
 * [CONS-003] Wrapped in per-pane mutex to prevent interleaving.
 */
async function prepareForInjection(paneId) {
  return withPaneLock(paneId, async () => {
    await sendControlChar(27, paneId);  // Escape
    await delay(100);
    await sendControlChar(21, paneId);  // Ctrl+U
    await delay(50);
  });
}

/**
 * Send Shift+Tab to toggle mode.
 */
async function sendModeToggle(paneId) {
  await tmuxSendKeys(paneId, 'BTab');
  console.log(`[Mode Toggle Pane ${paneId}] Sent Shift+Tab`);
}

/**
 * Legacy inject — not supported on Linux.
 * tmux send-keys is reliable and doesn't need a clipboard-based fallback.
 */
async function injectCommandLegacy() {
  throw new Error('Legacy inject not supported on Linux — use tmux send-keys via injectCommand');
}

/**
 * Legacy escape — not supported on Linux.
 */
async function sendEscapeKeyLegacy() {
  throw new Error('Legacy escape not supported on Linux — use sendEscapeKey');
}

// --- Health check ---

/**
 * Verify tmux is installed and the server is running.
 * [CONS-013] Returns {ok, paneCount?, error?}. ok:true with paneCount:0 means
 * tmux is healthy but no panes exist — this is a valid non-error state.
 */
async function healthCheck() {
  try {
    await execFileAsync('which', ['tmux'], { timeout: TMUX_EXEC_TIMEOUT_MS });
  } catch {
    return { ok: false, error: 'tmux not installed. Install with: sudo dnf install tmux' };
  }

  try {
    const { stdout } = await execFileAsync('tmux', ['list-panes', '-a', '-F', '#{pane_id}'], {
      timeout: TMUX_EXEC_TIMEOUT_MS,
    });
    const paneCount = stdout.trim().split('\n').filter(l => l.trim()).length;
    return { ok: true, paneCount };
  } catch (err) {
    if (err.stderr && err.stderr.includes('no server running')) {
      return { ok: false, error: 'tmux server not running. Start with: tmux new -s claude' };
    }
    return { ok: false, error: 'tmux health check failed' };
  }
}

module.exports = {
  validateTarget,
  getActiveProcesses,
  injectCommand,
  selectOption,
  sendControlChar,
  sendEscapeKey,
  prepareForInjection,
  sendModeToggle,
  injectCommandLegacy,
  sendEscapeKeyLegacy,
  healthCheck,
  // Exposed for testing
  sanitizeCommand,
  withPaneLock,
  MAX_COMMAND_LENGTH,
  TMUX_EXEC_TIMEOUT_MS,
  CHAR_CODE_MAP,
};
