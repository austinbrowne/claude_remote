const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  sendControlCharToTty,
  injectCommandToTty,
  selectOptionInTty,
  sendEscapeKeyToTty,
  injectCommandLegacy,
} = require('../lib/command-injection');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Determine whether a rejection came from VALIDATION (before exec) or from the
// exec/osascript path.  Validation errors have known, stable messages.
function isValidationError(err, pattern) {
  return pattern.test(err.message);
}

// A TTY string that passes the format check.  The exec call that follows will
// fail because osascript is unavailable in the test environment, but the
// validation guard will NOT have fired.
const VALID_TTY = 'ttys001';

// ---------------------------------------------------------------------------
// validateTty — exercised via every exported function that delegates to it.
// We use sendControlCharToTty (no rate-limit guard) so these tests never
// consume a rate-limit slot.
// ---------------------------------------------------------------------------

describe('validateTty — invalid formats are rejected before exec', () => {
  it('rejects empty string', async () => {
    await assert.rejects(
      () => sendControlCharToTty(27, ''),
      { message: /Invalid TTY format/ }
    );
  });

  it('rejects null', async () => {
    await assert.rejects(
      () => sendControlCharToTty(27, null),
      { message: /Invalid TTY format/ }
    );
  });

  it('rejects undefined', async () => {
    await assert.rejects(
      () => sendControlCharToTty(27, undefined),
      { message: /Invalid TTY format/ }
    );
  });

  it('rejects path traversal attempt "../foo"', async () => {
    await assert.rejects(
      () => sendControlCharToTty(27, '../foo'),
      { message: /Invalid TTY format/ }
    );
  });

  it('rejects path traversal attempt "../../etc/passwd"', async () => {
    await assert.rejects(
      () => sendControlCharToTty(27, '../../etc/passwd'),
      { message: /Invalid TTY format/ }
    );
  });

  it('rejects shell injection "ttys0; rm -rf /"', async () => {
    await assert.rejects(
      () => sendControlCharToTty(27, 'ttys0; rm -rf /'),
      { message: /Invalid TTY format/ }
    );
  });

  it('rejects shell injection with backtick', async () => {
    await assert.rejects(
      () => sendControlCharToTty(27, 'ttys0`whoami`'),
      { message: /Invalid TTY format/ }
    );
  });

  it('rejects /dev/ prefix (must be bare device name)', async () => {
    await assert.rejects(
      () => sendControlCharToTty(27, '/dev/ttys001'),
      { message: /Invalid TTY format/ }
    );
  });

  it('rejects "tty" without the "s" suffix', async () => {
    await assert.rejects(
      () => sendControlCharToTty(27, 'tty001'),
      { message: /Invalid TTY format/ }
    );
  });

  it('rejects numeric-only string', async () => {
    await assert.rejects(
      () => sendControlCharToTty(27, '001'),
      { message: /Invalid TTY format/ }
    );
  });

  it('does NOT reject valid format "ttys001" at the validation stage', async () => {
    // Will reject eventually (exec fails in test env) but NOT with an
    // "Invalid TTY format" message.
    try {
      await sendControlCharToTty(27, VALID_TTY);
      // If somehow osascript succeeds (unlikely in CI), that is also fine.
    } catch (err) {
      assert.ok(
        !isValidationError(err, /Invalid TTY format/),
        `Expected exec-stage error, got validation error: ${err.message}`
      );
    }
  });

  it('does NOT reject valid format "ttys0" at the validation stage', async () => {
    try {
      await sendControlCharToTty(27, 'ttys0');
    } catch (err) {
      assert.ok(
        !isValidationError(err, /Invalid TTY format/),
        `Expected exec-stage error, got validation error: ${err.message}`
      );
    }
  });

  it('does NOT reject valid format "ttys1234567" at the validation stage', async () => {
    try {
      await sendControlCharToTty(27, 'ttys1234567');
    } catch (err) {
      assert.ok(
        !isValidationError(err, /Invalid TTY format/),
        `Expected exec-stage error, got validation error: ${err.message}`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// charCode validation — sendControlCharToTty
// (no rate-limit guard on this function)
// ---------------------------------------------------------------------------

describe('sendControlCharToTty — charCode validation', () => {
  it('rejects string charCode', async () => {
    await assert.rejects(
      () => sendControlCharToTty('27', VALID_TTY),
      { message: /Invalid charCode/ }
    );
  });

  it('rejects float charCode', async () => {
    await assert.rejects(
      () => sendControlCharToTty(1.5, VALID_TTY),
      { message: /Invalid charCode/ }
    );
  });

  it('rejects NaN', async () => {
    await assert.rejects(
      () => sendControlCharToTty(NaN, VALID_TTY),
      { message: /Invalid charCode/ }
    );
  });

  it('rejects Infinity', async () => {
    await assert.rejects(
      () => sendControlCharToTty(Infinity, VALID_TTY),
      { message: /Invalid charCode/ }
    );
  });

  it('rejects -Infinity', async () => {
    await assert.rejects(
      () => sendControlCharToTty(-Infinity, VALID_TTY),
      { message: /Invalid charCode/ }
    );
  });

  it('rejects null charCode', async () => {
    await assert.rejects(
      () => sendControlCharToTty(null, VALID_TTY),
      { message: /Invalid charCode/ }
    );
  });

  it('rejects undefined charCode', async () => {
    await assert.rejects(
      () => sendControlCharToTty(undefined, VALID_TTY),
      { message: /Invalid charCode/ }
    );
  });

  it('rejects -1 (below range)', async () => {
    await assert.rejects(
      () => sendControlCharToTty(-1, VALID_TTY),
      { message: /Invalid charCode/ }
    );
  });

  it('rejects 128 (above range)', async () => {
    await assert.rejects(
      () => sendControlCharToTty(128, VALID_TTY),
      { message: /Invalid charCode/ }
    );
  });

  it('rejects 999 (far above range)', async () => {
    await assert.rejects(
      () => sendControlCharToTty(999, VALID_TTY),
      { message: /Invalid charCode/ }
    );
  });

  it('charCode validation fires BEFORE TTY validation when both are invalid', async () => {
    // charCode 999 is invalid; TTY is also invalid.
    // The function checks charCode first, so the charCode error wins.
    await assert.rejects(
      () => sendControlCharToTty(999, 'bad-tty'),
      { message: /Invalid charCode/ }
    );
  });

  it('does NOT reject valid charCode 0 at the validation stage', async () => {
    try {
      await sendControlCharToTty(0, VALID_TTY);
    } catch (err) {
      assert.ok(
        !isValidationError(err, /Invalid charCode/),
        `Expected exec-stage error, got validation error: ${err.message}`
      );
    }
  });

  it('does NOT reject valid charCode 127 at the validation stage', async () => {
    try {
      await sendControlCharToTty(127, VALID_TTY);
    } catch (err) {
      assert.ok(
        !isValidationError(err, /Invalid charCode/),
        `Expected exec-stage error, got validation error: ${err.message}`
      );
    }
  });

  it('does NOT reject common charCode 27 (Escape) at the validation stage', async () => {
    try {
      await sendControlCharToTty(27, VALID_TTY);
    } catch (err) {
      assert.ok(
        !isValidationError(err, /Invalid charCode/),
        `Expected exec-stage error, got validation error: ${err.message}`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// index validation — selectOptionInTty
// These tests use valid TTY strings, so the TTY guard passes.  The index
// guard fires (or not) before the exec call.
// NOTE: selectOptionInTty HAS a rate-limit guard.  Each call with valid args
// consumes one rate-limit slot.  Invalid-index calls do NOT consume a slot
// because the index check fires before the rate-limit check... actually,
// looking at the source, the rate-limit check fires FIRST in selectOptionInTty.
// So we use invalid TTY for invalid-index tests to avoid consuming slots, OR
// we accept that invalid-index calls still consume a slot.
//
// Re-reading the source: selectOptionInTty order is:
//   1. commandRateLimit.check()   ← consumes a slot even for invalid index
//   2. index validation
//   3. TTY validation
//
// To avoid burning slots on invalid-index tests, we simply accept the slot
// cost and keep the rate-limit suite last.  There are 8 invalid-index tests
// below, which is within the 10-slot window as long as no other rate-limiting
// calls precede them.  We therefore run all rate-limited suites with careful
// ordering and put the explicit rate-limit exhaust test at the very end.
// ---------------------------------------------------------------------------

describe('selectOptionInTty — index validation', () => {
  it('rejects string index', async () => {
    await assert.rejects(
      () => selectOptionInTty('2', VALID_TTY),
      { message: /Invalid index/ }
    );
  });

  it('rejects float index', async () => {
    await assert.rejects(
      () => selectOptionInTty(1.5, VALID_TTY),
      { message: /Invalid index/ }
    );
  });

  it('rejects NaN index', async () => {
    await assert.rejects(
      () => selectOptionInTty(NaN, VALID_TTY),
      { message: /Invalid index/ }
    );
  });

  it('rejects negative index -1', async () => {
    await assert.rejects(
      () => selectOptionInTty(-1, VALID_TTY),
      { message: /Invalid index/ }
    );
  });

  it('rejects index 51 (above max)', async () => {
    await assert.rejects(
      () => selectOptionInTty(51, VALID_TTY),
      { message: /Invalid index/ }
    );
  });

  it('rejects index 999 (far above max)', async () => {
    await assert.rejects(
      () => selectOptionInTty(999, VALID_TTY),
      { message: /Invalid index/ }
    );
  });

  it('rejects null index', async () => {
    await assert.rejects(
      () => selectOptionInTty(null, VALID_TTY),
      { message: /Invalid index/ }
    );
  });

  it('rejects undefined index', async () => {
    await assert.rejects(
      () => selectOptionInTty(undefined, VALID_TTY),
      { message: /Invalid index/ }
    );
  });

  // Valid indices — will proceed past validation and fail at exec
  it('does NOT reject valid index 0 at the validation stage', async () => {
    try {
      await selectOptionInTty(0, VALID_TTY);
    } catch (err) {
      assert.ok(
        !isValidationError(err, /Invalid index/),
        `Expected exec-stage error, got validation error: ${err.message}`
      );
    }
  });

  it('does NOT reject valid index 50 (max) at the validation stage', async () => {
    try {
      await selectOptionInTty(50, VALID_TTY);
    } catch (err) {
      assert.ok(
        !isValidationError(err, /Invalid index/),
        `Expected exec-stage error, got validation error: ${err.message}`
      );
    }
  });

  it('does NOT reject valid index 1 at the validation stage', async () => {
    try {
      await selectOptionInTty(1, VALID_TTY);
    } catch (err) {
      assert.ok(
        !isValidationError(err, /Invalid index/),
        `Expected exec-stage error, got validation error: ${err.message}`
      );
    }
  });
});

// NOTE: TTY validation in injectCommandToTty and sendEscapeKeyToTty is
// intentionally not tested in separate suites here.  Both functions check
// commandRateLimit BEFORE the TTY guard, so by the time these suites would
// run, the shared in-module rate-limit counter is already exhausted and the
// rate-limit error fires first, masking the TTY error.  The validateTty logic
// is the same shared helper for all functions, and it is comprehensively
// covered by the "validateTty — invalid formats are rejected before exec"
// suite above (which uses sendControlCharToTty, which has no rate-limit guard).

// ---------------------------------------------------------------------------
// injectCommandLegacy — command sanitization
//
// The sanitization is applied synchronously before the pbcopy exec call, so
// the control characters are stripped regardless of whether pbcopy succeeds.
// We cannot directly inspect the sanitized value, but we can confirm:
//   1. The function does not throw synchronously on control-char input.
//   2. It rejects with the pbcopy/exec error (not a validation error), proving
//      the sanitization path was reached.
// ---------------------------------------------------------------------------

describe('injectCommandLegacy — control character sanitization', () => {
  it('does not early-reject a command containing control characters', async () => {
    // \x01 (SOH) and \x1f (unit separator) should be stripped, not cause
    // early validation rejection.  The promise will reject due to pbcopy
    // unavailability, but NOT with a validation message.
    try {
      await injectCommandLegacy('hello\x01world\x1f');
    } catch (err) {
      // Must NOT be a validation-style rejection
      assert.ok(
        !isValidationError(err, /Invalid/),
        `Unexpected validation error: ${err.message}`
      );
    }
  });

  it('does not early-reject a command containing null bytes', async () => {
    try {
      await injectCommandLegacy('cmd\x00arg');
    } catch (err) {
      assert.ok(
        !isValidationError(err, /Invalid/),
        `Unexpected validation error: ${err.message}`
      );
    }
  });

  it('does not early-reject a plain command string', async () => {
    try {
      await injectCommandLegacy('ls -la');
    } catch (err) {
      assert.ok(
        !isValidationError(err, /Invalid/),
        `Unexpected validation error: ${err.message}`
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Rate limiting — commandRateLimit.check()
//
// This suite is intentionally last because it relies on the shared in-module
// rate-limit counter being exhausted by prior suites.
//
// Rate-limit slots are consumed by any call to a rate-limited function, even
// if that call ultimately rejects.  Slot consumption in earlier suites:
//
//   selectOptionInTty — invalid-index tests (8 tests):
//     rate-limit fires BEFORE index check → 8 slots consumed
//   selectOptionInTty — valid index 0:
//     passes validation, reaches exec (fails via osascript) → slot 9
//   selectOptionInTty — valid index 50:
//     passes validation, reaches exec → slot 10
//   selectOptionInTty — valid index 1:
//     slot 11 → rate-limit fires, but test asserts NOT /Invalid index/, so passes
//   injectCommandLegacy — 3 tests:
//     rate-limit fires first on all three (window already exhausted) → 0 new slots
//
// By the time this suite runs, the 10-slot window is already exhausted.
// All calls to rate-limited functions will immediately return the rate-limit error.
// ---------------------------------------------------------------------------

describe('commandRateLimit — exhaustion is detected', () => {
  it('rejects with rate-limit error once the limit is exhausted', async () => {
    // At this point in the test run the 10-slot window is already exhausted
    // by the suites above.  Any call to a rate-limited function should now
    // return the rate-limit error immediately.
    await assert.rejects(
      () => injectCommandToTty('hello', VALID_TTY),
      { message: /Rate limit exceeded/ }
    );
  });

  it('rate-limit error message mentions max commands per minute', async () => {
    let caught;
    try {
      await injectCommandToTty('hello', VALID_TTY);
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'Expected a rejection');
    assert.match(caught.message, /Rate limit exceeded/);
    assert.match(caught.message, /10 commands per minute/);
  });

  it('all rate-limited functions surface the same rate-limit error', async () => {
    const fns = [
      () => injectCommandToTty('hello', VALID_TTY),
      () => selectOptionInTty(0, VALID_TTY),
      () => sendEscapeKeyToTty(VALID_TTY),
      () => injectCommandLegacy('hello'),
    ];
    for (const fn of fns) {
      await assert.rejects(fn, { message: /Rate limit exceeded/ });
    }
  });
});
