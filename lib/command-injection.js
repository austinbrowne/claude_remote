/**
 * Command injection facade.
 *
 * Delegates to the platform-specific adapter (macOS/iTerm or Linux/tmux)
 * while preserving the original export names so all callers in server.js
 * and watcher.js continue to work unchanged.
 *
 * Rate limiting is shared across platforms and enforced here.
 */
const { getPlatformAdapter } = require('./platform/detect');

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

// Returns a rejected promise if rate limit exceeded (preserves original API contract)
function rateLimitGuard() {
  if (!commandRateLimit.check()) {
    return Promise.reject(new Error('Rate limit exceeded: max 10 commands per minute'));
  }
  return null;
}

// [CONS-006-a] User-facing injection functions are rate-limited.
// sendControlCharToTty and prepareSessionForInjection are NOT rate-limited because:
// - sendControlCharToTty sends a single char (lightweight, used internally by prepareForInjection)
// - prepareSessionForInjection is a prep step called before injection (already gated by the inject rate limit)

// Send a raw control character to a session
// Common: 27 = Escape, 21 = Ctrl+U (clear line), 3 = Ctrl+C
function sendControlCharToTty(charCode, target) {
  return getPlatformAdapter().sendControlChar(charCode, target);
}

// Prepare a session for command injection: cancel processing + clear input
function prepareSessionForInjection(target) {
  return getPlatformAdapter().prepareForInjection(target);
}

// Inject a command to a specific session
function injectCommandToTty(command, target) {
  const limited = rateLimitGuard();
  if (limited) return limited;
  return getPlatformAdapter().injectCommand(command, target);
}

// Navigate an interactive selector (AskUserQuestion) by sending arrow keys
function selectOptionInTty(index, target) {
  const limited = rateLimitGuard();
  if (limited) return limited;
  return getPlatformAdapter().selectOption(index, target);
}

// Send escape key to a specific session
function sendEscapeKeyToTty(target) {
  const limited = rateLimitGuard();
  if (limited) return limited;
  return getPlatformAdapter().sendEscapeKey(target);
}

// Send Shift+Tab to toggle mode
function sendModeToggle(target) {
  const limited = rateLimitGuard();
  if (limited) return limited;
  return getPlatformAdapter().sendModeToggle(target);
}

// Legacy injection fallback (macOS only — throws on Linux)
function injectCommandLegacy(command) {
  const limited = rateLimitGuard();
  if (limited) return limited;
  return getPlatformAdapter().injectCommandLegacy(command);
}

// Legacy escape fallback (macOS only — throws on Linux)
function sendEscapeKeyLegacy() {
  return getPlatformAdapter().sendEscapeKeyLegacy();
}

module.exports = {
  sendControlCharToTty,
  prepareSessionForInjection,
  injectCommandToTty,
  selectOptionInTty,
  sendEscapeKeyToTty,
  sendModeToggle,
  injectCommandLegacy,
  sendEscapeKeyLegacy
};
