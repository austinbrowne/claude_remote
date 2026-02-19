const { exec } = require('child_process');

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

// CONS-012: Shared TTY validator — reused by all TTY-targeting functions.
// Accepts only the bare device name (e.g. "ttys001") without the /dev/ prefix.
function validateTty(tty) {
  if (!/^ttys\d+$/.test(tty)) {
    return new Error('Invalid TTY format');
  }
  return null;
}

// Inject command to a specific iTerm session by TTY (works on background tabs)
// Send a raw control character to a session (bypasses sanitizer)
// Common: 27 = Escape, 21 = Ctrl+U (clear line), 3 = Ctrl+C
function sendControlCharToTty(charCode, tty) {
  // CONS-007: Validate charCode is an integer in 0-127 before AppleScript interpolation
  if (!Number.isInteger(charCode) || charCode < 0 || charCode > 127) {
    return Promise.reject(new Error('Invalid charCode: must be an integer between 0 and 127'));
  }

  const ttyErr = validateTty(tty);
  if (ttyErr) return Promise.reject(ttyErr);

  return new Promise((resolve, reject) => {
    const targetTty = `/dev/${tty}`;
    const appleScript = `
      tell application "iTerm2"
        repeat with w in windows
          repeat with t in tabs of w
            repeat with s in sessions of t
              if tty of s is "${targetTty}" then
                tell s to write text (ASCII character ${charCode}) newline no
                return "ok"
              end if
            end repeat
          end repeat
        end repeat
        return "not found"
      end tell
    `;
    exec(`osascript -e '${appleScript.replace(/'/g, "'\"'\"'")}'`, (err, stdout) => {
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}

// Prepare a session for command injection: cancel processing + clear input
async function prepareSessionForInjection(tty) {
  await sendControlCharToTty(27, tty);  // Escape — cancel any processing
  await new Promise(r => setTimeout(r, 1500));
  await sendControlCharToTty(21, tty);  // Ctrl+U — clear input line
  await new Promise(r => setTimeout(r, 500));
}

function injectCommandToTty(command, tty) {
  // Rate limit check
  if (!commandRateLimit.check()) {
    return Promise.reject(new Error('Rate limit exceeded: max 10 commands per minute'));
  }

  // CONS-012: Use shared TTY validator
  const ttyErr = validateTty(tty);
  if (ttyErr) return Promise.reject(ttyErr);

  return new Promise((resolve, reject) => {
    // Strip null bytes and control characters (except \t\n\r which are escaped below)
    const sanitized = command.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
    // Escape the command for AppleScript string (prevent injection)
    const escaped = sanitized
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n')
      .replace(/\t/g, '\\t');
    const targetTty = `/dev/${tty}`;

    // Use iTerm's native write text command - works on any session without activation
    // Write text without auto-newline, delay briefly, then send CR to submit
    const appleScript = `
      tell application "iTerm2"
        repeat with w in windows
          repeat with t in tabs of w
            repeat with s in sessions of t
              if tty of s is "${targetTty}" then
                tell s
                  write text "${escaped}" newline no
                  delay 0.2
                  write text (ASCII character 13) newline no
                end tell
                return "ok"
              end if
            end repeat
          end repeat
        end repeat
        return "not found"
      end tell
    `;

    exec(`osascript -e '${appleScript.replace(/'/g, "'\"'\"'")}'`, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
      } else if (stdout.trim() === 'not found') {
        reject(new Error(`Session with TTY ${tty} not found`));
      } else {
        console.log(`[Inject TTY ${tty}] ${command.substring(0, 50)}${command.length > 50 ? '...' : ''}`);
        resolve();
      }
    });
  });
}

// Navigate an interactive selector by sending arrow-down keys then Enter.
// Used for AskUserQuestion prompts where the ink Select component only
// responds to arrow keys, not typed text.
function selectOptionInTty(index, tty) {
  if (!commandRateLimit.check()) {
    return Promise.reject(new Error('Rate limit exceeded: max 10 commands per minute'));
  }

  // CONS-006: Validate index is a non-negative integer within a reasonable upper bound
  if (!Number.isInteger(index) || index < 0 || index > 50) {
    return Promise.reject(new Error('Invalid index: must be an integer between 0 and 50'));
  }

  // CONS-012: Use shared TTY validator
  const ttyErr = validateTty(tty);
  if (ttyErr) return Promise.reject(ttyErr);

  return new Promise((resolve, reject) => {
    const targetTty = `/dev/${tty}`;

    // Build arrow-down sequence: ESC (ASCII 27) + "[B" for each step
    let arrowCommands = '';
    for (let i = 0; i < index; i++) {
      arrowCommands += `                    write text (ASCII character 27) & "[B" newline no\n`;
    }

    const appleScript = `
      tell application "iTerm2"
        repeat with w in windows
          repeat with t in tabs of w
            repeat with s in sessions of t
              if tty of s is "${targetTty}" then
                tell s
${arrowCommands}                    write text (ASCII character 13) newline no
                end tell
                return "ok"
              end if
            end repeat
          end repeat
        end repeat
        return "not found"
      end tell
    `;

    exec(`osascript -e '${appleScript.replace(/'/g, "'\"'\"'")}'`, (err, stdout) => {
      if (err) {
        reject(new Error(err.message));
      } else if (stdout.trim() === 'not found') {
        reject(new Error(`Session with TTY ${tty} not found`));
      } else {
        console.log(`[SelectOption TTY ${tty}] index=${index}`);
        resolve();
      }
    });
  });
}

// Send escape key to a specific iTerm session by TTY
function sendEscapeKeyToTty(tty) {
  // CONS-001: Rate limit check (was missing)
  if (!commandRateLimit.check()) {
    return Promise.reject(new Error('Rate limit exceeded: max 10 commands per minute'));
  }

  // CONS-001: TTY validation (was missing); CONS-012: use shared validator
  const ttyErr = validateTty(tty);
  if (ttyErr) return Promise.reject(ttyErr);

  return new Promise((resolve, reject) => {
    const targetTty = `/dev/${tty}`;

    // Write escape character (ASCII 27) directly to the session
    const appleScript = `
      tell application "iTerm2"
        repeat with w in windows
          repeat with t in tabs of w
            repeat with s in sessions of t
              if tty of s is "${targetTty}" then
                tell s to write text (ASCII character 27) newline no
                return "ok"
              end if
            end repeat
          end repeat
        end repeat
        return "not found"
      end tell
    `;

    exec(`osascript -e '${appleScript.replace(/'/g, "'\"'\"'")}'`, (error, stdout) => {
      if (error) reject(error);
      else if (stdout.trim() === 'not found') {
        reject(new Error(`Session with TTY ${tty} not found`));
      } else {
        console.log(`[Inject TTY ${tty}] Escape key`);
        resolve();
      }
    });
  });
}

// Send Shift+Tab to toggle mode (activates iTerm - no background option)
function sendModeToggle() {
  return new Promise((resolve, reject) => {
    const appleScript = `
      tell application "iTerm2" to activate
      delay 0.1
      tell application "System Events"
        key code 48 using shift down
      end tell
    `;

    exec(`osascript -e '${appleScript.replace(/'/g, "'\"'\"'")}'`, (error) => {
      if (error) {
        console.error('[Mode Toggle] Failed:', error.message);
        reject(error);
      } else {
        console.log('[Mode Toggle] Sent Shift+Tab');
        resolve();
      }
    });
  });
}

// Legacy injection (activates iTerm - used as fallback)
function injectCommandLegacy(command) {
  if (!commandRateLimit.check()) {
    return Promise.reject(new Error('Rate limit exceeded: max 10 commands per minute'));
  }

  return new Promise((resolve, reject) => {
    const pbcopy = exec('pbcopy', (error) => {
      if (error) {
        reject(new Error('Failed to copy to clipboard'));
        return;
      }

      const appleScript = `
        tell application "iTerm" to activate
        delay 0.4
        tell application "System Events" to tell process "iTerm2"
          keystroke "v" using command down
          delay 0.3
          keystroke return
        end tell
      `;

      exec(`osascript -e '${appleScript}'`, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr || err.message));
        } else {
          console.log(`[Inject Legacy] ${command.substring(0, 50)}${command.length > 50 ? '...' : ''}`);
          resolve();
        }
      });
    });

    // CONS-002: Strip control characters before writing to pbcopy stdin,
    // matching the same pattern used in injectCommandToTty.
    const sanitized = command.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');

    // CONS-002: Wrap write in try/catch to handle a closed pipe gracefully.
    try {
      pbcopy.stdin.write(sanitized);
      pbcopy.stdin.end();
    } catch (writeErr) {
      reject(new Error(`Failed to write to pbcopy stdin: ${writeErr.message}`));
    }
  });
}

function sendEscapeKeyLegacy() {
  const appleScript = `
    tell application "iTerm"
      activate
      delay 0.2
      tell application "System Events"
        tell process "iTerm2"
          key code 53
        end tell
      end tell
    end tell
  `;

  return new Promise((resolve, reject) => {
    exec(`osascript -e '${appleScript.replace(/'/g, "'\"'\"'")}'`, (error) => {
      if (error) reject(error);
      else {
        console.log('[Inject Legacy] Escape key');
        resolve();
      }
    });
  });
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
