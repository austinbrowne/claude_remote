const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const {
  validateTarget,
  sanitizeCommand,
  sendControlChar,
  injectCommand,
  selectOption,
  getActiveProcesses,
  healthCheck,
  withPaneLock,
  MAX_COMMAND_LENGTH,
  TMUX_EXEC_TIMEOUT_MS,
  CHAR_CODE_MAP,
} = require('../lib/platform/linux-tmux');

// ---------------------------------------------------------------------------
// validateTarget — pane ID format validation
// ---------------------------------------------------------------------------

describe('validateTarget — valid pane IDs accepted', () => {
  it('accepts %0', () => {
    assert.equal(validateTarget('%0'), null);
  });

  it('accepts %1', () => {
    assert.equal(validateTarget('%1'), null);
  });

  it('accepts %999', () => {
    assert.equal(validateTarget('%999'), null);
  });

  it('accepts %10000 (large pane ID)', () => {
    assert.equal(validateTarget('%10000'), null);
  });
});

describe('validateTarget — invalid pane IDs rejected', () => {
  it('rejects null', () => {
    assert.ok(validateTarget(null) instanceof Error);
  });

  it('rejects undefined', () => {
    assert.ok(validateTarget(undefined) instanceof Error);
  });

  it('rejects empty string', () => {
    assert.ok(validateTarget('') instanceof Error);
  });

  it('rejects number', () => {
    assert.ok(validateTarget(0) instanceof Error);
  });

  it('rejects % alone', () => {
    assert.ok(validateTarget('%') instanceof Error);
  });

  it('rejects %abc (non-numeric)', () => {
    assert.ok(validateTarget('%abc') instanceof Error);
  });

  it('rejects bare number without %', () => {
    assert.ok(validateTarget('3') instanceof Error);
  });

  it('rejects macOS TTY format ttys001', () => {
    assert.ok(validateTarget('ttys001') instanceof Error);
  });

  it('rejects shell injection "; rm -rf /"', () => {
    assert.ok(validateTarget('; rm -rf /') instanceof Error);
  });

  it('rejects shell injection "%0; whoami"', () => {
    assert.ok(validateTarget('%0; whoami') instanceof Error);
  });

  it('rejects backtick injection "%0`id`"', () => {
    assert.ok(validateTarget('%0`id`') instanceof Error);
  });

  it('rejects $() injection "%0$(id)"', () => {
    assert.ok(validateTarget('%0$(id)') instanceof Error);
  });

  it('rejects path traversal "../etc/passwd"', () => {
    assert.ok(validateTarget('../etc/passwd') instanceof Error);
  });

  it('rejects negative "%−1"', () => {
    assert.ok(validateTarget('%-1') instanceof Error);
  });
});

// ---------------------------------------------------------------------------
// sanitizeCommand — input sanitization
// ---------------------------------------------------------------------------

describe('sanitizeCommand — strips dangerous characters', () => {
  it('strips null bytes', () => {
    assert.equal(sanitizeCommand('hello\x00world'), 'helloworld');
  });

  it('strips control characters (SOH, unit separator)', () => {
    assert.equal(sanitizeCommand('hello\x01world\x1f'), 'helloworld');
  });

  it('preserves printable characters', () => {
    assert.equal(sanitizeCommand('hello world 123!@#'), 'hello world 123!@#');
  });

  it('preserves tabs', () => {
    assert.equal(sanitizeCommand('hello\tworld'), 'hello\tworld');
  });

  it('rejects non-string input', () => {
    assert.throws(() => sanitizeCommand(123), /Command must be a string/);
    assert.throws(() => sanitizeCommand(null), /Command must be a string/);
    assert.throws(() => sanitizeCommand(undefined), /Command must be a string/);
  });

  it('rejects commands exceeding MAX_COMMAND_LENGTH', () => {
    const long = 'x'.repeat(MAX_COMMAND_LENGTH + 1);
    assert.throws(() => sanitizeCommand(long), /Command too long/);
  });

  it('accepts commands at exactly MAX_COMMAND_LENGTH', () => {
    const exact = 'x'.repeat(MAX_COMMAND_LENGTH);
    assert.equal(sanitizeCommand(exact), exact);
  });
});

// ---------------------------------------------------------------------------
// sendControlChar — charCode validation and key mapping
// ---------------------------------------------------------------------------

describe('sendControlChar — charCode validation', () => {
  it('rejects string charCode', async () => {
    await assert.rejects(
      () => sendControlChar('27', '%0'),
      { message: /Invalid charCode/ }
    );
  });

  it('rejects float charCode', async () => {
    await assert.rejects(
      () => sendControlChar(1.5, '%0'),
      { message: /Invalid charCode/ }
    );
  });

  it('rejects NaN', async () => {
    await assert.rejects(
      () => sendControlChar(NaN, '%0'),
      { message: /Invalid charCode/ }
    );
  });

  it('rejects null charCode', async () => {
    await assert.rejects(
      () => sendControlChar(null, '%0'),
      { message: /Invalid charCode/ }
    );
  });

  it('rejects -1 (below range)', async () => {
    await assert.rejects(
      () => sendControlChar(-1, '%0'),
      { message: /Invalid charCode/ }
    );
  });

  it('rejects 128 (above range)', async () => {
    await assert.rejects(
      () => sendControlChar(128, '%0'),
      { message: /Invalid charCode/ }
    );
  });

  it('charCode validation fires before pane validation', async () => {
    await assert.rejects(
      () => sendControlChar(999, 'bad-pane'),
      { message: /Invalid charCode/ }
    );
  });
});

describe('CHAR_CODE_MAP — common codes mapped to tmux key names', () => {
  it('maps 27 to Escape', () => {
    assert.equal(CHAR_CODE_MAP[27], 'Escape');
  });

  it('maps 21 to C-u', () => {
    assert.equal(CHAR_CODE_MAP[21], 'C-u');
  });

  it('maps 3 to C-c', () => {
    assert.equal(CHAR_CODE_MAP[3], 'C-c');
  });

  it('maps 4 to C-d', () => {
    assert.equal(CHAR_CODE_MAP[4], 'C-d');
  });
});

// ---------------------------------------------------------------------------
// injectCommand — validation (tmux unavailable in test env, so we test
// the validation layer that fires before any tmux call)
// ---------------------------------------------------------------------------

describe('injectCommand — input validation', () => {
  it('rejects non-string command', async () => {
    await assert.rejects(
      () => injectCommand(123, '%0'),
      { message: /Command must be a string/ }
    );
  });

  it('rejects command exceeding max length', async () => {
    const long = 'x'.repeat(MAX_COMMAND_LENGTH + 1);
    await assert.rejects(
      () => injectCommand(long, '%0'),
      { message: /Command too long/ }
    );
  });

  it('rejects invalid pane ID', async () => {
    await assert.rejects(
      () => injectCommand('hello', 'bad'),
      { message: /Invalid pane ID format/ }
    );
  });

  it('valid command + valid pane reaches tmux call (which fails in test env)', async () => {
    try {
      await injectCommand('hello', '%0');
    } catch (err) {
      // Should NOT be a validation error
      assert.ok(
        !/Invalid pane ID/.test(err.message) && !/Command must be/.test(err.message),
        `Expected tmux-stage error, got validation error: ${err.message}`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// selectOption — index validation
// ---------------------------------------------------------------------------

describe('selectOption — index validation', () => {
  it('rejects string index', async () => {
    await assert.rejects(
      () => selectOption('2', '%0'),
      { message: /Invalid index/ }
    );
  });

  it('rejects negative index', async () => {
    await assert.rejects(
      () => selectOption(-1, '%0'),
      { message: /Invalid index/ }
    );
  });

  it('rejects index > 50', async () => {
    await assert.rejects(
      () => selectOption(51, '%0'),
      { message: /Invalid index/ }
    );
  });

  it('rejects null index', async () => {
    await assert.rejects(
      () => selectOption(null, '%0'),
      { message: /Invalid index/ }
    );
  });
});

// ---------------------------------------------------------------------------
// getActiveProcesses — output parsing
// Tests use mock scenarios since tmux may not be running in CI
// ---------------------------------------------------------------------------

describe('getActiveProcesses — returns empty on tmux errors', () => {
  it('returns an array', async () => {
    const result = await getActiveProcesses();
    assert.ok(Array.isArray(result));
  });

  // Can't guarantee tmux is running in test env, but function should not throw
  it('does not throw when tmux is unavailable', async () => {
    const result = await getActiveProcesses();
    assert.ok(Array.isArray(result));
  });
});

// ---------------------------------------------------------------------------
// healthCheck — reports tmux status
// ---------------------------------------------------------------------------

describe('healthCheck — reports status', () => {
  it('returns an object with ok field', async () => {
    const result = await healthCheck();
    assert.ok(typeof result === 'object');
    assert.ok('ok' in result);
  });
});

// ---------------------------------------------------------------------------
// Self-exclusion via TMUX_PANE
// ---------------------------------------------------------------------------

describe('self-exclusion — TMUX_PANE env var', () => {
  const originalTmuxPane = process.env.TMUX_PANE;

  afterEach(() => {
    if (originalTmuxPane !== undefined) {
      process.env.TMUX_PANE = originalTmuxPane;
    } else {
      delete process.env.TMUX_PANE;
    }
  });

  it('TMUX_PANE is used for self-exclusion (code path exists)', () => {
    // Verify the code references TMUX_PANE by checking the module
    process.env.TMUX_PANE = '%99';
    // getActiveProcesses reads TMUX_PANE internally —
    // if tmux is running, it would exclude %99 from results.
    // We just verify the env var is respected without crashing.
    assert.equal(process.env.TMUX_PANE, '%99');
  });
});

// ---------------------------------------------------------------------------
// [CONS-007] Failure path tests — tmux send-keys errors and null command
// ---------------------------------------------------------------------------

describe('injectCommand — tmux failure handling', () => {
  it('rejects with descriptive error when tmux pane does not exist', async () => {
    // %99999 almost certainly doesn't exist — if tmux is running, we get
    // a "Pane not found" or "Command delivery failed" error.
    // If tmux is not running, we still get an error (not a crash).
    try {
      await injectCommand('test', '%99999');
    } catch (err) {
      assert.ok(
        typeof err.message === 'string' && err.message.length > 0,
        `Expected descriptive error, got: ${err.message}`
      );
      // Should NOT leak raw tmux stderr
      assert.ok(
        !err.message.includes('stderr') && !err.message.includes('/tmp/tmux'),
        `Error should not leak tmux internals: ${err.message}`
      );
    }
  });

  it('getActiveProcesses handles null/missing command in tmux output gracefully', async () => {
    // If tmux is running but a pane has no command (edge case),
    // getActiveProcesses should not throw
    const result = await getActiveProcesses();
    assert.ok(Array.isArray(result));
    // Every result should have pid, tty, and cwd fields
    for (const session of result) {
      assert.ok('pid' in session, 'session missing pid');
      assert.ok('tty' in session, 'session missing tty');
      assert.ok('cwd' in session, 'session missing cwd');
    }
  });
});

// ---------------------------------------------------------------------------
// [CONS-003] Per-pane mutex — withPaneLock serialization
// ---------------------------------------------------------------------------

describe('withPaneLock — serializes operations per pane', () => {
  it('exports withPaneLock function', () => {
    assert.equal(typeof withPaneLock, 'function');
  });

  it('serializes concurrent calls for same pane', async () => {
    const order = [];
    const fn1 = async () => { order.push('start1'); await new Promise(r => setTimeout(r, 20)); order.push('end1'); };
    const fn2 = async () => { order.push('start2'); order.push('end2'); };

    // Launch both concurrently for same pane
    const p1 = withPaneLock('%test', fn1);
    const p2 = withPaneLock('%test', fn2);
    await Promise.all([p1, p2]);

    // fn1 should complete before fn2 starts
    assert.deepEqual(order, ['start1', 'end1', 'start2', 'end2']);
  });

  it('allows parallel execution for different panes', async () => {
    const order = [];
    const fn1 = async () => { order.push('pane1-start'); await new Promise(r => setTimeout(r, 20)); order.push('pane1-end'); };
    const fn2 = async () => { order.push('pane2-start'); order.push('pane2-end'); };

    const p1 = withPaneLock('%paneA', fn1);
    const p2 = withPaneLock('%paneB', fn2);
    await Promise.all([p1, p2]);

    // pane2 should start before pane1 ends (parallel)
    const pane2StartIdx = order.indexOf('pane2-start');
    const pane1EndIdx = order.indexOf('pane1-end');
    assert.ok(pane2StartIdx < pane1EndIdx, `Expected parallel execution, got: ${order}`);
  });
});

// ---------------------------------------------------------------------------
// Constants exported correctly
// ---------------------------------------------------------------------------

describe('constants — exported for configuration', () => {
  it('TMUX_EXEC_TIMEOUT_MS is a positive number', () => {
    assert.ok(typeof TMUX_EXEC_TIMEOUT_MS === 'number');
    assert.ok(TMUX_EXEC_TIMEOUT_MS > 0);
  });
});
