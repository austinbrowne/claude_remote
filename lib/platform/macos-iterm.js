/**
 * macOS/iTerm platform adapter.
 *
 * Session discovery via ps + lsof (macOS TTY format ttysXXX).
 * Command injection via AppleScript (osascript) targeting iTerm2.
 *
 * Extracted from lib/command-injection.js and lib/session-discovery.js.
 */
const { exec } = require('child_process');

const MAX_COMMAND_LENGTH = 10000; // [CONS-005] Consistent length limit across adapters

// --- Target validation ---

function validateTarget(tty) {
  if (!/^ttys\d+$/.test(tty)) {
    return new Error('Invalid TTY format');
  }
  return null;
}

// --- Session discovery ---

function getActiveProcesses() {
  return new Promise((resolve) => {
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

        const pidToCwd = {};
        lsofOutput.split('\n').forEach(line => {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 9 && parts[3] === 'cwd') {
            const pid = parts[1];
            const cwd = parts[parts.length - 1];
            pidToCwd[pid] = cwd;
          }
        });

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

// --- Command injection ---

function sendControlChar(charCode, tty) {
  if (!Number.isInteger(charCode) || charCode < 0 || charCode > 127) {
    return Promise.reject(new Error('Invalid charCode: must be an integer between 0 and 127'));
  }

  const ttyErr = validateTarget(tty);
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

async function prepareForInjection(tty) {
  await sendControlChar(27, tty);  // Escape
  await new Promise(r => setTimeout(r, 1500));
  await sendControlChar(21, tty);  // Ctrl+U
  await new Promise(r => setTimeout(r, 500));
}

function injectCommand(command, tty) {
  const ttyErr = validateTarget(tty);
  if (ttyErr) return Promise.reject(ttyErr);

  // [CONS-005] Enforce command length limit consistent with Linux adapter
  if (typeof command !== 'string') return Promise.reject(new Error('Command must be a string'));
  if (command.length > MAX_COMMAND_LENGTH) {
    return Promise.reject(new Error(`Command too long: ${command.length} chars (max ${MAX_COMMAND_LENGTH})`));
  }

  return new Promise((resolve, reject) => {
    const sanitized = command.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
    const escaped = sanitized
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n')
      .replace(/\t/g, '\\t');
    const targetTty = `/dev/${tty}`;

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

function selectOption(index, tty) {
  if (!Number.isInteger(index) || index < 0 || index > 50) {
    return Promise.reject(new Error('Invalid index: must be an integer between 0 and 50'));
  }

  const ttyErr = validateTarget(tty);
  if (ttyErr) return Promise.reject(ttyErr);

  return new Promise((resolve, reject) => {
    const targetTty = `/dev/${tty}`;

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

function sendEscapeKey(tty) {
  const ttyErr = validateTarget(tty);
  if (ttyErr) return Promise.reject(ttyErr);

  return new Promise((resolve, reject) => {
    const targetTty = `/dev/${tty}`;

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

function injectCommandLegacy(command) {
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

    const sanitized = command.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');

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

async function healthCheck() {
  return new Promise((resolve) => {
    exec('which osascript', (err) => {
      if (err) {
        resolve({ ok: false, error: 'osascript not available (not macOS?)' });
      } else {
        resolve({ ok: true });
      }
    });
  });
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
};
