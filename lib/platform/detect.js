const os = require('os');
const { execFileSync } = require('child_process');

let cachedAdapter = null;

/**
 * Returns the platform-specific adapter for session discovery and command injection.
 * Auto-detects via os.platform() or can be overridden with CLAUDE_REMOTE_PLATFORM env var.
 *
 * IMPORTANT: CLAUDE_REMOTE_PLATFORM must be set before the first require() of this module.
 * The adapter is cached after first resolution. Call resetAdapter() in tests if needed.
 *
 * Adapter interface:
 *   getActiveProcesses()           → Promise<[{pid, tty, cwd}]>
 *   validateTarget(target)         → Error|null
 *   injectCommand(command, target) → Promise<void>
 *   selectOption(index, target)    → Promise<void>
 *   sendControlChar(charCode, tgt) → Promise<void>
 *   sendEscapeKey(target)          → Promise<void>
 *   prepareForInjection(target)    → Promise<void>
 *   sendModeToggle(target)         → Promise<void>
 *   injectCommandLegacy(command)   → Promise<void>
 *   sendEscapeKeyLegacy()          → Promise<void>
 *   healthCheck()                  → Promise<{ok, error?}>
 */
function getPlatformAdapter() {
  if (cachedAdapter) return cachedAdapter;

  const detected = os.platform();
  const override = process.env.CLAUDE_REMOTE_PLATFORM;
  const platform = override || detected;

  // [CONS-009-a] Log warning and validate binary when env override is used
  if (override && override !== detected) {
    console.warn(`[Platform] CLAUDE_REMOTE_PLATFORM="${override}" overrides detected platform "${detected}"`);
    try {
      const binary = override === 'linux' ? 'tmux' : 'osascript';
      execFileSync('which', [binary], { timeout: 2000 });
    } catch {
      const binary = override === 'linux' ? 'tmux' : 'osascript';
      throw new Error(`Platform override "${override}" requires ${binary}, but it is not installed.`);
    }
  }

  if (platform === 'linux') {
    cachedAdapter = require('./linux-tmux');
  } else if (platform === 'darwin') {
    cachedAdapter = require('./macos-iterm');
  } else {
    throw new Error(`Unsupported platform: ${platform}. Set CLAUDE_REMOTE_PLATFORM to 'linux' or 'darwin'.`);
  }

  return cachedAdapter;
}

// For testing: reset the cached adapter
function resetAdapter() {
  cachedAdapter = null;
}

module.exports = { getPlatformAdapter, resetAdapter };
