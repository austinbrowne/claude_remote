const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// =============================================================================
// Replicated fallback approval logic from prompts.js
// (prompts.js runs in the browser and can't be imported directly)
// =============================================================================

const VALID_APPROVAL_COMMANDS = ['y', 'n', 'always'];
const FALLBACK_DEBOUNCE_MS = 2000;

/**
 * Simulates getCurrentSessionStatus — reads session status from a sessions map.
 */
function getCurrentSessionStatus(currentSessionId, sessionsMap) {
  if (!currentSessionId) return null;
  return sessionsMap.get(currentSessionId)?.status || null;
}

/**
 * Simulates checkFallbackApproval — determines if fallback should show.
 * Returns { shouldShow, shouldStartTimer, shouldHide }.
 */
function evaluateFallbackState(currentSessionId, sessionsMap, currentPrompt, timerActive) {
  const status = getCurrentSessionStatus(currentSessionId, sessionsMap);
  const isWaiting = status === 'waiting';
  const hasPrompt = currentPrompt !== null;

  if (isWaiting && !hasPrompt && currentSessionId) {
    if (!timerActive) {
      return { shouldStartTimer: true, shouldHide: false };
    }
    return { shouldStartTimer: false, shouldHide: false };
  }
  return { shouldStartTimer: false, shouldHide: true };
}

/**
 * Simulates fallbackApprove — validates command before sending.
 * Returns the message to send, or null if rejected.
 */
function buildFallbackMessage(command, currentSessionId) {
  if (!currentSessionId) return null;
  if (!VALID_APPROVAL_COMMANDS.includes(command)) return null;
  return { action: 'inject', command, sessionId: currentSessionId };
}

describe('Fallback approval', () => {

  describe('getCurrentSessionStatus', () => {
    it('returns null when no session ID', () => {
      const sessions = new Map();
      assert.equal(getCurrentSessionStatus(null, sessions), null);
      assert.equal(getCurrentSessionStatus(undefined, sessions), null);
      assert.equal(getCurrentSessionStatus('', sessions), null);
    });

    it('returns null when session not in map', () => {
      const sessions = new Map();
      assert.equal(getCurrentSessionStatus('unknown', sessions), null);
    });

    it('returns status for known session', () => {
      const sessions = new Map([['s1', { status: 'waiting' }]]);
      assert.equal(getCurrentSessionStatus('s1', sessions), 'waiting');
    });

    it('returns null when session has no status', () => {
      const sessions = new Map([['s1', {}]]);
      assert.equal(getCurrentSessionStatus('s1', sessions), null);
    });
  });

  describe('evaluateFallbackState', () => {
    let sessions;

    beforeEach(() => {
      sessions = new Map([
        ['s1', { status: 'waiting' }],
        ['s2', { status: 'processing' }],
        ['s3', { status: 'idle' }],
      ]);
    });

    it('starts timer when waiting + no prompt + has session', () => {
      const result = evaluateFallbackState('s1', sessions, null, false);
      assert.equal(result.shouldStartTimer, true);
      assert.equal(result.shouldHide, false);
    });

    it('does not restart timer if already running', () => {
      const result = evaluateFallbackState('s1', sessions, null, true);
      assert.equal(result.shouldStartTimer, false);
      assert.equal(result.shouldHide, false);
    });

    it('hides when status is processing', () => {
      const result = evaluateFallbackState('s2', sessions, null, false);
      assert.equal(result.shouldHide, true);
    });

    it('hides when status is idle', () => {
      const result = evaluateFallbackState('s3', sessions, null, false);
      assert.equal(result.shouldHide, true);
    });

    it('hides when prompt is active', () => {
      const result = evaluateFallbackState('s1', sessions, { type: 'permission' }, false);
      assert.equal(result.shouldHide, true);
    });

    it('hides when no session ID', () => {
      const result = evaluateFallbackState(null, sessions, null, false);
      assert.equal(result.shouldHide, true);
    });

    it('hides when session unknown (no status)', () => {
      const result = evaluateFallbackState('unknown', sessions, null, false);
      assert.equal(result.shouldHide, true);
    });

    it('rapid calls: second call does not restart timer', () => {
      // First call starts timer
      const r1 = evaluateFallbackState('s1', sessions, null, false);
      assert.equal(r1.shouldStartTimer, true);
      // Second call with timer now active
      const r2 = evaluateFallbackState('s1', sessions, null, true);
      assert.equal(r2.shouldStartTimer, false);
      assert.equal(r2.shouldHide, false);
    });

    it('status change cancels: waiting → processing → waiting restarts timer', () => {
      // First waiting starts timer
      const r1 = evaluateFallbackState('s1', sessions, null, false);
      assert.equal(r1.shouldStartTimer, true);
      // Status changes to processing → hide
      sessions.set('s1', { status: 'processing' });
      const r2 = evaluateFallbackState('s1', sessions, null, true);
      assert.equal(r2.shouldHide, true);
      // Back to waiting → new timer
      sessions.set('s1', { status: 'waiting' });
      const r3 = evaluateFallbackState('s1', sessions, null, false);
      assert.equal(r3.shouldStartTimer, true);
    });
  });

  describe('buildFallbackMessage (allowlist + command validation)', () => {
    it('accepts "y" command', () => {
      const msg = buildFallbackMessage('y', 's1');
      assert.deepEqual(msg, { action: 'inject', command: 'y', sessionId: 's1' });
    });

    it('accepts "n" command', () => {
      const msg = buildFallbackMessage('n', 's1');
      assert.deepEqual(msg, { action: 'inject', command: 'n', sessionId: 's1' });
    });

    it('accepts "always" command', () => {
      const msg = buildFallbackMessage('always', 's1');
      assert.deepEqual(msg, { action: 'inject', command: 'always', sessionId: 's1' });
    });

    it('rejects arbitrary string command', () => {
      assert.equal(buildFallbackMessage('rm -rf /', 's1'), null);
    });

    it('rejects empty string', () => {
      assert.equal(buildFallbackMessage('', 's1'), null);
    });

    it('rejects numeric string', () => {
      assert.equal(buildFallbackMessage('1', 's1'), null);
    });

    it('rejects null command', () => {
      assert.equal(buildFallbackMessage(null, 's1'), null);
    });

    it('rejects when no session ID', () => {
      assert.equal(buildFallbackMessage('y', null), null);
      assert.equal(buildFallbackMessage('y', ''), null);
    });

    it('rejects case-sensitive variants', () => {
      assert.equal(buildFallbackMessage('Y', 's1'), null);
      assert.equal(buildFallbackMessage('Always', 's1'), null);
      assert.equal(buildFallbackMessage('N', 's1'), null);
    });
  });

  describe('FALLBACK_DEBOUNCE_MS constant', () => {
    it('is 2000ms', () => {
      assert.equal(FALLBACK_DEBOUNCE_MS, 2000);
    });
  });
});
