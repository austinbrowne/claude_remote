const os = require('os');
const { execFileSync } = require('child_process');

let cachedAdapter = null;

/**
 * Returns the platform-specific adapter for session discovery and command injection.
 *
 * Adapter selection priority:
 *   1. CLAUDE_REMOTE_ADAPTER=tmux  → tmux adapter (works on any OS, recommended for macOS+tmux)
 *   2. CLAUDE_REMOTE_PLATFORM      → override platform detection (backwards-compatible for Linux)
 *   3. os.platform() auto-detect   → darwin=iTerm/AppleScript, linux=tmux
 *
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

  // Priority 1: Explicit adapter override (works on any OS without platform lie)
  const adapterOverride = process.env.CLAUDE_REMOTE_ADAPTER;
  if (adapterOverride === 'tmux') {
    try {
      execFileSync('which', ['tmux'], { timeout: 2000 });
    } catch {
      throw new Error('CLAUDE_REMOTE_ADAPTER=tmux requires tmux, but it is not installed.');
    }
    console.log('[Platform] Using tmux adapter (CLAUDE_REMOTE_ADAPTER=tmux)');
    cachedAdapter = require('./linux-tmux');
    return cachedAdapter;
  }

  // Priority 2: Platform override (backwards-compatible)
  const detected = os.platform();
  const override = process.env.CLAUDE_REMOTE_PLATFORM;
  const platform = override || detected;

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

  // Priority 3: Auto-detect
  if (platform === 'linux') {
    cachedAdapter = require('./linux-tmux');
  } else if (platform === 'darwin') {
    cachedAdapter = require('./macos-iterm');
  } else {
    throw new Error(`Unsupported platform: ${platform}. Set CLAUDE_REMOTE_ADAPTER=tmux or CLAUDE_REMOTE_PLATFORM to 'linux' or 'darwin'.`);
  }

  return cachedAdapter;
}

// For testing: reset the cached adapter
function resetAdapter() {
  cachedAdapter = null;
}

module.exports = { getPlatformAdapter, resetAdapter };
