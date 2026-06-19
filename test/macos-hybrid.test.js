const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  validateTarget,
  isTmuxTarget,
} = require('../lib/platform/macos-hybrid');

// ---------------------------------------------------------------------------
// isTmuxTarget — target format detection
// ---------------------------------------------------------------------------

describe('isTmuxTarget — tmux pane IDs', () => {
  it('returns true for %0', () => {
    assert.equal(isTmuxTarget('%0'), true);
  });

  it('returns true for %15', () => {
    assert.equal(isTmuxTarget('%15'), true);
  });

  it('returns true for %999', () => {
    assert.equal(isTmuxTarget('%999'), true);
  });
});

describe('isTmuxTarget — non-tmux targets', () => {
  it('returns false for ttys001', () => {
    assert.equal(isTmuxTarget('ttys001'), false);
  });

  it('returns false for ttys010', () => {
    assert.equal(isTmuxTarget('ttys010'), false);
  });

  it('returns false for undefined', () => {
    assert.equal(isTmuxTarget(undefined), false);
  });

  it('returns false for null', () => {
    assert.equal(isTmuxTarget(null), false);
  });

  it('returns false for empty string', () => {
    assert.equal(isTmuxTarget(''), false);
  });

  it('returns false for number', () => {
    assert.equal(isTmuxTarget(42), false);
  });
});

// ---------------------------------------------------------------------------
// validateTarget — dual-format validation
// ---------------------------------------------------------------------------

describe('validateTarget — accepts tmux pane IDs', () => {
  it('accepts %0', () => {
    assert.equal(validateTarget('%0'), null);
  });

  it('accepts %15', () => {
    assert.equal(validateTarget('%15'), null);
  });

  it('accepts %999', () => {
    assert.equal(validateTarget('%999'), null);
  });
});

describe('validateTarget — accepts iTerm TTY devices', () => {
  it('accepts ttys001', () => {
    assert.equal(validateTarget('ttys001'), null);
  });

  it('accepts ttys010', () => {
    assert.equal(validateTarget('ttys010'), null);
  });

  it('accepts ttys999', () => {
    assert.equal(validateTarget('ttys999'), null);
  });
});

describe('validateTarget — rejects invalid targets', () => {
  it('rejects null', () => {
    assert.ok(validateTarget(null) instanceof Error);
  });

  it('rejects undefined', () => {
    assert.ok(validateTarget(undefined) instanceof Error);
  });

  it('rejects empty string', () => {
    assert.ok(validateTarget('') instanceof Error);
  });

  it('rejects bare number', () => {
    assert.ok(validateTarget('123') instanceof Error);
  });

  it('rejects %abc (non-numeric pane ID)', () => {
    assert.ok(validateTarget('%abc') instanceof Error);
  });

  it('rejects ttysXYZ (non-numeric TTY)', () => {
    assert.ok(validateTarget('ttysXYZ') instanceof Error);
  });

  it('rejects injection attempt %0;id', () => {
    assert.ok(validateTarget('%0;id') instanceof Error);
  });

  it('rejects injection attempt ttys0$(whoami)', () => {
    assert.ok(validateTarget('ttys0$(whoami)') instanceof Error);
  });

  it('rejects path traversal', () => {
    assert.ok(validateTarget('../../../etc/passwd') instanceof Error);
  });

  it('rejects /dev/ttys001 (full path not accepted)', () => {
    assert.ok(validateTarget('/dev/ttys001') instanceof Error);
  });
});
