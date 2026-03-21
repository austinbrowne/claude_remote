const os = require('os');
const { execFileSync } = require('child_process');

let cachedAdapter = null;

/**
 * Returns the platform-specific adapter for session discovery and command injection.
 *
 * Adapter selection priority:
 *   1. CLAUDE_REMOTE_ADAPTER=tmux  → hybrid adapter on macOS (tmux + iTerm), pure tmux on Linux
 *      CLAUDE_REMOTE_ADAPTER=iterm → pure iTerm adapter on macOS (opt-out from hybrid)
 *   2. CLAUDE_REMOTE_PLATFORM      → override platform detection (backwards-compatible for Linux)
 *   3. os.platform() auto-detect   → darwin=hybrid (if tmux available) or iTerm, linux=tmux
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

  // Priority 1: Explicit adapter override
  const adapterOverride = process.env.CLAUDE_REMOTE_ADAPTER;
  const detected = os.platform();

  if (adapterOverride === 'tmux') {
    try {
      execFileSync('which', ['tmux'], { timeout: 2000 });
    } catch {
      throw new Error('CLAUDE_REMOTE_ADAPTER=tmux requires tmux, but it is not installed.');
    }
    // On macOS: use hybrid adapter (tmux + iTerm) for full session discovery
    if (detected === 'darwin') {
      console.log('[Platform] Using hybrid adapter (macOS + tmux)');
      cachedAdapter = require('./macos-hybrid');
    } else {
      console.log('[Platform] Using tmux adapter (CLAUDE_REMOTE_ADAPTER=tmux)');
      cachedAdapter = require('./linux-tmux');
    }
    return cachedAdapter;
  }

  if (adapterOverride === 'iterm') {
    if (detected !== 'darwin') {
      throw new Error('CLAUDE_REMOTE_ADAPTER=iterm requires macOS (darwin).');
    }
    console.log('[Platform] Using iTerm adapter (CLAUDE_REMOTE_ADAPTER=iterm)');
    cachedAdapter = require('./macos-iterm');
    return cachedAdapter;
  }

  // Priority 2: Platform override (backwards-compatible)
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
    // Use hybrid adapter if tmux is available, pure iTerm otherwise
    try {
      execFileSync('which', ['tmux'], { timeout: 2000 });
      console.log('[Platform] Using hybrid adapter (macOS + tmux detected)');
      cachedAdapter = require('./macos-hybrid');
    } catch {
      cachedAdapter = require('./macos-iterm');
    }
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
