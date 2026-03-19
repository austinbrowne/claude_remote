const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Replicate server-side event architecture logic from server.js
// (server.js can't be imported directly due to side effects)

// --- updatePromptState logic (server.js:249-282) ---
function updatePromptState(sessionData, event) {
  if (!sessionData || !event) return;

  if (event.type === 'permission_request' || event.type === 'ask_user_question') {
    const promptId = event.toolUseId || `prompt-${sessionData.lastBroadcastSeq}`;
    sessionData.pendingPrompts.set(promptId, {
      promptId,
      type: event.type,
      tool: event.tool,
      toolUseId: event.toolUseId,
      data: event,
      seq: sessionData.lastBroadcastSeq,
      timestamp: Date.now()
    });
  }

  if (event.type === 'tool_result' && event.toolUseId) {
    sessionData.pendingPrompts.delete(event.toolUseId);
  }

  if (event.type === 'user') {
    for (const [id, prompt] of sessionData.pendingPrompts) {
      if (prompt.type === 'ask_user_question') {
        sessionData.pendingPrompts.delete(id);
        break;
      }
    }
  }
}

// --- broadcastToClients recentEvents logic (server.js:222-230) ---
const EXCLUDED_FROM_REPLAY = new Set([
  'session_status', 'typing', 'heartbeat',
  'session_delta', 'pending_prompts', 'session_suspect', 'session_alive'
]);
const RECENT_EVENTS_CAP = 100;
const COMPACTION_SLACK = 20;

function storeRecentEvent(sessionData, message) {
  if (EXCLUDED_FROM_REPLAY.has(message.type)) return false;
  const seq = ++sessionData.lastBroadcastSeq;
  const stored = { seq, ...message, timestamp: Date.now() };
  sessionData.recentEvents.push(stored);
  if (sessionData.recentEvents.length > RECENT_EVENTS_CAP + COMPACTION_SLACK) {
    sessionData.recentEvents = sessionData.recentEvents.slice(-RECENT_EVENTS_CAP);
  }
  return true;
}

// --- validateActiveSession logic (server.js:499-511) ---
function validateActiveSession(sessionData, failCount) {
  if (!sessionData || failCount >= 3) return null;
  return sessionData;
}

// --- Liveness failCount logic (server.js:336-355) ---
function processLivenessCheck(sessionData, isAlive) {
  if (isAlive) {
    const wasRecovery = sessionData.failCount > 0;
    sessionData.failCount = 0;
    return wasRecovery ? 'recovered' : 'alive';
  } else {
    sessionData.failCount++;
    if (sessionData.failCount === 1) return 'suspect';
    if (sessionData.failCount >= 3) return 'dead';
    return 'failing';
  }
}

function createSessionData() {
  return {
    pendingPrompts: new Map(),
    lastBroadcastSeq: 0,
    recentEvents: [],
    failCount: 0
  };
}

describe('updatePromptState (CONS-010)', () => {
  it('adds permission_request to pendingPrompts', () => {
    const sd = createSessionData();
    sd.lastBroadcastSeq = 5;
    updatePromptState(sd, { type: 'permission_request', toolUseId: 'tool-1', tool: 'Bash' });
    assert.strictEqual(sd.pendingPrompts.size, 1);
    assert.ok(sd.pendingPrompts.has('tool-1'));
    const prompt = sd.pendingPrompts.get('tool-1');
    assert.strictEqual(prompt.type, 'permission_request');
    assert.strictEqual(prompt.tool, 'Bash');
  });

  it('adds ask_user_question with seq-based fallback ID', () => {
    const sd = createSessionData();
    sd.lastBroadcastSeq = 10;
    updatePromptState(sd, { type: 'ask_user_question', data: { questions: ['Q1'] } });
    assert.strictEqual(sd.pendingPrompts.size, 1);
    assert.ok(sd.pendingPrompts.has('prompt-10'));
  });

  it('clears prompt on tool_result with matching toolUseId', () => {
    const sd = createSessionData();
    sd.lastBroadcastSeq = 1;
    updatePromptState(sd, { type: 'permission_request', toolUseId: 'tool-1', tool: 'Edit' });
    assert.strictEqual(sd.pendingPrompts.size, 1);
    updatePromptState(sd, { type: 'tool_result', toolUseId: 'tool-1' });
    assert.strictEqual(sd.pendingPrompts.size, 0);
  });

  it('does not clear on tool_result without toolUseId', () => {
    const sd = createSessionData();
    sd.lastBroadcastSeq = 1;
    updatePromptState(sd, { type: 'permission_request', toolUseId: 'tool-1', tool: 'Bash' });
    updatePromptState(sd, { type: 'tool_result' });
    assert.strictEqual(sd.pendingPrompts.size, 1);
  });

  it('FIFO clears oldest ask_user_question on user event', () => {
    const sd = createSessionData();
    sd.lastBroadcastSeq = 1;
    updatePromptState(sd, { type: 'ask_user_question', data: {} });
    sd.lastBroadcastSeq = 2;
    updatePromptState(sd, { type: 'permission_request', toolUseId: 'perm-1', tool: 'Bash' });
    assert.strictEqual(sd.pendingPrompts.size, 2);
    updatePromptState(sd, { type: 'user' });
    assert.strictEqual(sd.pendingPrompts.size, 1);
    assert.ok(sd.pendingPrompts.has('perm-1'));
  });

  it('user event does nothing when no ask_user_question pending', () => {
    const sd = createSessionData();
    sd.lastBroadcastSeq = 1;
    updatePromptState(sd, { type: 'permission_request', toolUseId: 'perm-1', tool: 'Bash' });
    updatePromptState(sd, { type: 'user' });
    assert.strictEqual(sd.pendingPrompts.size, 1);
  });

  it('handles null sessionData gracefully', () => {
    assert.doesNotThrow(() => updatePromptState(null, { type: 'output' }));
  });

  it('handles null event gracefully', () => {
    const sd = createSessionData();
    assert.doesNotThrow(() => updatePromptState(sd, null));
  });
});

describe('recentEvents buffer and compaction (CONS-010)', () => {
  it('stores non-excluded events', () => {
    const sd = createSessionData();
    const stored = storeRecentEvent(sd, { type: 'output', content: 'hello' });
    assert.strictEqual(stored, true);
    assert.strictEqual(sd.recentEvents.length, 1);
    assert.strictEqual(sd.recentEvents[0].seq, 1);
  });

  it('skips excluded event types', () => {
    const sd = createSessionData();
    for (const type of EXCLUDED_FROM_REPLAY) {
      const stored = storeRecentEvent(sd, { type });
      assert.strictEqual(stored, false, `Should skip ${type}`);
    }
    assert.strictEqual(sd.recentEvents.length, 0);
  });

  it('increments seq monotonically', () => {
    const sd = createSessionData();
    storeRecentEvent(sd, { type: 'output', content: '1' });
    storeRecentEvent(sd, { type: 'output', content: '2' });
    storeRecentEvent(sd, { type: 'output', content: '3' });
    assert.deepStrictEqual(
      sd.recentEvents.map(e => e.seq),
      [1, 2, 3]
    );
  });

  it('compacts at cap + slack boundary', () => {
    const sd = createSessionData();
    // Fill to exactly cap + slack (120)
    for (let i = 0; i < RECENT_EVENTS_CAP + COMPACTION_SLACK; i++) {
      storeRecentEvent(sd, { type: 'output', content: `msg-${i}` });
    }
    assert.strictEqual(sd.recentEvents.length, RECENT_EVENTS_CAP + COMPACTION_SLACK);

    // One more triggers compaction
    storeRecentEvent(sd, { type: 'output', content: 'trigger' });
    assert.strictEqual(sd.recentEvents.length, RECENT_EVENTS_CAP);
  });

  it('preserves most recent events after compaction', () => {
    const sd = createSessionData();
    for (let i = 0; i < RECENT_EVENTS_CAP + COMPACTION_SLACK + 1; i++) {
      storeRecentEvent(sd, { type: 'output', content: `msg-${i}` });
    }
    // After compaction, the last event should be the most recent
    const last = sd.recentEvents[sd.recentEvents.length - 1];
    assert.strictEqual(last.content, `msg-${RECENT_EVENTS_CAP + COMPACTION_SLACK}`);
    // First event should be the (slack+1)th event
    const first = sd.recentEvents[0];
    assert.strictEqual(first.content, `msg-${COMPACTION_SLACK + 1}`);
  });

  it('handles empty buffer', () => {
    const sd = createSessionData();
    assert.strictEqual(sd.recentEvents.length, 0);
  });
});

describe('validateActiveSession (CONS-010)', () => {
  it('returns sessionData when alive (failCount < 3)', () => {
    const sd = createSessionData();
    sd.failCount = 0;
    assert.strictEqual(validateActiveSession(sd, sd.failCount), sd);
  });

  it('returns sessionData at failCount=2 (not yet dead)', () => {
    const sd = createSessionData();
    sd.failCount = 2;
    assert.strictEqual(validateActiveSession(sd, sd.failCount), sd);
  });

  it('returns null at failCount=3 (dead)', () => {
    const sd = createSessionData();
    sd.failCount = 3;
    assert.strictEqual(validateActiveSession(sd, sd.failCount), null);
  });

  it('returns null at failCount > 3', () => {
    const sd = createSessionData();
    sd.failCount = 10;
    assert.strictEqual(validateActiveSession(sd, sd.failCount), null);
  });

  it('returns null when sessionData is null', () => {
    assert.strictEqual(validateActiveSession(null, 0), null);
  });

  it('returns null when sessionData is undefined', () => {
    assert.strictEqual(validateActiveSession(undefined, 0), null);
  });
});

describe('Liveness failCount state machine (CONS-010)', () => {
  it('stays alive when process is found', () => {
    const sd = createSessionData();
    const result = processLivenessCheck(sd, true);
    assert.strictEqual(result, 'alive');
    assert.strictEqual(sd.failCount, 0);
  });

  it('transitions to suspect on first failure', () => {
    const sd = createSessionData();
    const result = processLivenessCheck(sd, false);
    assert.strictEqual(result, 'suspect');
    assert.strictEqual(sd.failCount, 1);
  });

  it('transitions to failing on second failure', () => {
    const sd = createSessionData();
    processLivenessCheck(sd, false); // 1
    const result = processLivenessCheck(sd, false); // 2
    assert.strictEqual(result, 'failing');
    assert.strictEqual(sd.failCount, 2);
  });

  it('transitions to dead on third failure', () => {
    const sd = createSessionData();
    processLivenessCheck(sd, false);
    processLivenessCheck(sd, false);
    const result = processLivenessCheck(sd, false);
    assert.strictEqual(result, 'dead');
    assert.strictEqual(sd.failCount, 3);
  });

  it('recovers from suspect back to alive', () => {
    const sd = createSessionData();
    processLivenessCheck(sd, false); // suspect
    const result = processLivenessCheck(sd, true); // recovered
    assert.strictEqual(result, 'recovered');
    assert.strictEqual(sd.failCount, 0);
  });

  it('recovers from failing (failCount=2) back to alive', () => {
    const sd = createSessionData();
    processLivenessCheck(sd, false);
    processLivenessCheck(sd, false);
    const result = processLivenessCheck(sd, true);
    assert.strictEqual(result, 'recovered');
    assert.strictEqual(sd.failCount, 0);
  });

  it('repeated alive checks return alive not recovered', () => {
    const sd = createSessionData();
    assert.strictEqual(processLivenessCheck(sd, true), 'alive');
    assert.strictEqual(processLivenessCheck(sd, true), 'alive');
  });
});

describe('EXCLUDED_FROM_REPLAY set', () => {
  it('contains all expected types', () => {
    const expected = ['session_status', 'typing', 'heartbeat', 'session_delta', 'pending_prompts', 'session_suspect', 'session_alive'];
    for (const type of expected) {
      assert.ok(EXCLUDED_FROM_REPLAY.has(type), `Missing: ${type}`);
    }
  });

  it('does not exclude normal event types', () => {
    const normal = ['output', 'tool_result', 'permission_request', 'ask_user_question', 'user', 'mode_change'];
    for (const type of normal) {
      assert.ok(!EXCLUDED_FROM_REPLAY.has(type), `Should not exclude: ${type}`);
    }
  });
});
