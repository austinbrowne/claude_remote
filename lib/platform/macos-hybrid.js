/**
 * macOS hybrid platform adapter.
 *
 * Combines tmux and iTerm adapters for full session discovery on macOS.
 * Discovers sessions in both tmux panes (via tmux list-panes) and regular
 * iTerm tabs (via ps scan). Deduplicates by matching tmux pane TTY devices
 * against ps-reported TTYs. Routes injection by target format:
 *   %N  → tmux send-keys
 *   ttysN → AppleScript/osascript
 *
 * Selected automatically on macOS when tmux is available.
 * Opt out with CLAUDE_REMOTE_ADAPTER=iterm for pure iTerm behavior.
 */
const tmux = require('./linux-tmux');
const iterm = require('./macos-iterm');

// --- Target format detection ---

/**
 * Check if a target is a tmux pane ID (%N format).
 * Returns false for undefined/null (routes to iTerm as fallback).
 */
function isTmuxTarget(target) {
  return typeof target === 'string' && /^%\d+$/.test(target);
}

// --- Target validation ---

/**
 * Validate a target in either format.
 * Delegates to the appropriate adapter's strict validator.
 */
function validateTarget(target) {
  if (!target || typeof target !== 'string') {
    return new Error('Invalid target: must be a non-empty string');
  }
  if (/^%\d+$/.test(target)) return tmux.validateTarget(target);
  if (/^ttys\d+$/.test(target)) return iterm.validateTarget(target);
  return new Error('Invalid target format: expected %N (tmux) or ttysN (iTerm)');
}

// --- Session discovery ---

/**
 * Discover active Claude sessions from both tmux panes and iTerm tabs.
 * Deduplicates by matching tmux pane device TTYs against iTerm ps results.
 * Normalizes iTerm results to include isClaude field for session-discovery.js.
 */
async function getActiveProcesses() {
  // Run both adapters in parallel
  const [tmuxResults, itermResults] = await Promise.all([
    tmux.getActiveProcesses().catch(err => {
      console.warn(`[Hybrid] tmux discovery failed: ${err.message}`);
      return null; // null signals failure — skip iTerm dedup to avoid duplicates
    }),
    iterm.getActiveProcesses().catch(err => {
      console.warn(`[Hybrid] iTerm discovery failed: ${err.message}`);
      return [];
    })
  ]);

  // If tmux discovery failed, skip iTerm scan to prevent duplicates
  // (without the TTY Set, every tmux session would appear twice)
  if (tmuxResults === null) {
    return [];
  }

  // Build TTY Set from tmux results for dedup
  // deviceTty is e.g. "/dev/ttys010" — strip /dev/ to match iTerm's "ttys010" format
  const tmuxTtys = new Set();
  for (const result of tmuxResults) {
    if (result.deviceTty) {
      tmuxTtys.add(result.deviceTty.replace(/^\/dev\//, ''));
    }
  }

  // Filter iTerm results: exclude processes already in tmux panes
  const nonTmuxResults = itermResults.filter(p => !tmuxTtys.has(p.tty));

  // Normalize iTerm results: add isClaude field
  // iTerm's ps scan already filters for "claude" processes, so all results are Claude
  const normalizedItermResults = nonTmuxResults.map(p => ({
    ...p,
    isClaude: true,
  }));

  return [...tmuxResults, ...normalizedItermResults];
}

// --- Command injection (routed by target format) ---

async function injectCommand(command, target) {
  return isTmuxTarget(target)
    ? tmux.injectCommand(command, target)
    : iterm.injectCommand(command, target);
}

async function selectOption(index, target) {
  return isTmuxTarget(target)
    ? tmux.selectOption(index, target)
    : iterm.selectOption(index, target);
}

async function sendControlChar(charCode, target) {
  return isTmuxTarget(target)
    ? tmux.sendControlChar(charCode, target)
    : iterm.sendControlChar(charCode, target);
}

async function sendEscapeKey(target) {
  return isTmuxTarget(target)
    ? tmux.sendEscapeKey(target)
    : iterm.sendEscapeKey(target);
}

async function prepareForInjection(target) {
  return isTmuxTarget(target)
    ? tmux.prepareForInjection(target)
    : iterm.prepareForInjection(target);
}

/**
 * Send Shift+Tab to toggle mode.
 * Routes by target format. If target is undefined (legacy call path),
 * defaults to iTerm (global System Events keystroke).
 */
async function sendModeToggle(target) {
  return isTmuxTarget(target)
    ? tmux.sendModeToggle(target)
    : iterm.sendModeToggle();
}

// --- Legacy functions ---
// Legacy inject uses clipboard + paste to frontmost iTerm window.
// Not TTY-targeted. Only useful as a fallback for iTerm sessions.

function injectCommandLegacy(command) {
  return iterm.injectCommandLegacy(command);
}

function sendEscapeKeyLegacy() {
  return iterm.sendEscapeKeyLegacy();
}

// --- Health check ---

/**
 * Check health of both sub-adapters.
 * Returns ok if at least one adapter is healthy.
 * Includes per-adapter status for diagnostics.
 */
async function healthCheck() {
  const [tmuxHealth, itermHealth] = await Promise.all([
    tmux.healthCheck(),
    iterm.healthCheck()
  ]);

  const ok = tmuxHealth.ok || itermHealth.ok;

  if (!tmuxHealth.ok) {
    console.warn(`[Hybrid] tmux adapter degraded: ${tmuxHealth.error}`);
  }
  if (!itermHealth.ok) {
    console.warn(`[Hybrid] iTerm adapter degraded: ${itermHealth.error}`);
  }

  return {
    ok,
    tmux: tmuxHealth,
    iterm: itermHealth,
    ...(ok && (!tmuxHealth.ok || !itermHealth.ok) ? { degraded: true } : {}),
  };
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
  isTmuxTarget,
};
