const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Replicate client-side event architecture logic from public/js/connection.js
// (can't import browser code directly — replicate the functions under test)

// --- Seq dedup logic (connection.js:33-37) ---
function createSeqDedup() {
  let lastReceivedSeq = 0;
  return {
    shouldProcess(msg) {
      if (msg.seq != null) {
        if (msg.seq <= lastReceivedSeq) return false;
        lastReceivedSeq = msg.seq;
      }
      return true;
    },
    getLastSeq() { return lastReceivedSeq; },
    reset() { lastReceivedSeq = 0; }
  };
}

// --- handleSessionDelta logic (connection.js:113-122) ---
// Events excluded from replay — must match server-side EXCLUDED_FROM_REPLAY
const EXCLUDED_FROM_REPLAY = new Set([
  'session_status', 'typing', 'heartbeat',
  'session_delta', 'pending_prompts', 'session_suspect', 'session_alive'
]);

function processSessionDelta(msg, currentSessionId, handleMessage) {
  if (msg.sessionId !== currentSessionId || !Array.isArray(msg.events)) return [];
  const processed = [];
  for (const event of msg.events) {
    if (event.type === 'session_delta' || event.type === 'pending_prompts') continue;
    processed.push(event);
    handleMessage(event);
  }
  return processed;
}

// --- handlePendingPrompts logic (connection.js:94-110) ---
function processPendingPrompts(msg, currentSessionId) {
  if (msg.sessionId !== currentSessionId || !Array.isArray(msg.prompts)) return [];
  const results = [];
  for (const prompt of msg.prompts) {
    if (prompt.type === 'ask_user_question') {
      results.push({ action: 'structured', data: prompt.data?.questions || prompt.data });
    } else if (prompt.type === 'permission_request') {
      results.push({ action: 'permission', tool: prompt.tool, toolUseId: prompt.toolUseId });
    }
  }
  return results;
}

describe('Seq dedup (CONS-009)', () => {
  it('accepts first message with seq=1', () => {
    const dedup = createSeqDedup();
    assert.strictEqual(dedup.shouldProcess({ seq: 1, type: 'output' }), true);
    assert.strictEqual(dedup.getLastSeq(), 1);
  });

  it('drops duplicate seq', () => {
    const dedup = createSeqDedup();
    assert.strictEqual(dedup.shouldProcess({ seq: 1 }), true);
    assert.strictEqual(dedup.shouldProcess({ seq: 1 }), false);
  });

  it('drops out-of-order (lower) seq', () => {
    const dedup = createSeqDedup();
    dedup.shouldProcess({ seq: 5 });
    assert.strictEqual(dedup.shouldProcess({ seq: 3 }), false);
  });

  it('accepts sequential messages', () => {
    const dedup = createSeqDedup();
    assert.strictEqual(dedup.shouldProcess({ seq: 1 }), true);
    assert.strictEqual(dedup.shouldProcess({ seq: 2 }), true);
    assert.strictEqual(dedup.shouldProcess({ seq: 3 }), true);
    assert.strictEqual(dedup.getLastSeq(), 3);
  });

  it('skips dedup for messages without seq (null/undefined)', () => {
    const dedup = createSeqDedup();
    assert.strictEqual(dedup.shouldProcess({ type: 'sessions' }), true);
    assert.strictEqual(dedup.shouldProcess({}), true);
    assert.strictEqual(dedup.getLastSeq(), 0);
  });

  it('first real seq=1 is accepted when lastReceivedSeq is 0', () => {
    // This is the CONS-001 scenario — AV proved it's not a bug because
    // server uses pre-increment so seq starts at 1, not 0
    const dedup = createSeqDedup();
    assert.strictEqual(dedup.shouldProcess({ seq: 1 }), true);
  });

  it('reset sets lastReceivedSeq back to 0', () => {
    const dedup = createSeqDedup();
    dedup.shouldProcess({ seq: 10 });
    dedup.reset();
    assert.strictEqual(dedup.getLastSeq(), 0);
    assert.strictEqual(dedup.shouldProcess({ seq: 1 }), true);
  });
});

describe('handleSessionDelta (CONS-009)', () => {
  it('replays allowed event types via handleMessage', () => {
    const processed = [];
    const handler = (event) => processed.push(event);
    const events = [
      { type: 'output', content: 'hello' },
      { type: 'tool_result', toolUseId: 'abc' }
    ];
    processSessionDelta({ sessionId: 'sess1', events }, 'sess1', handler);
    assert.strictEqual(processed.length, 2);
    assert.strictEqual(processed[0].type, 'output');
    assert.strictEqual(processed[1].type, 'tool_result');
  });

  it('filters out session_delta from replayed events (CONS-001 recursion guard)', () => {
    const processed = [];
    const handler = (event) => processed.push(event);
    const events = [
      { type: 'output', content: 'hello' },
      { type: 'session_delta', events: [] },
      { type: 'tool_result', toolUseId: 'abc' }
    ];
    processSessionDelta({ sessionId: 'sess1', events }, 'sess1', handler);
    assert.strictEqual(processed.length, 2);
    assert.ok(processed.every(e => e.type !== 'session_delta'));
  });

  it('filters out pending_prompts from replayed events', () => {
    const processed = [];
    const handler = (event) => processed.push(event);
    const events = [
      { type: 'pending_prompts', prompts: [] },
      { type: 'output', content: 'hello' }
    ];
    processSessionDelta({ sessionId: 'sess1', events }, 'sess1', handler);
    assert.strictEqual(processed.length, 1);
    assert.strictEqual(processed[0].type, 'output');
  });

  it('ignores delta for wrong session', () => {
    const processed = [];
    const handler = (event) => processed.push(event);
    processSessionDelta({ sessionId: 'other', events: [{ type: 'output' }] }, 'sess1', handler);
    assert.strictEqual(processed.length, 0);
  });

  it('handles missing events array gracefully', () => {
    const processed = [];
    const handler = (event) => processed.push(event);
    processSessionDelta({ sessionId: 'sess1' }, 'sess1', handler);
    assert.strictEqual(processed.length, 0);
  });

  it('handles empty events array', () => {
    const processed = [];
    const handler = (event) => processed.push(event);
    processSessionDelta({ sessionId: 'sess1', events: [] }, 'sess1', handler);
    assert.strictEqual(processed.length, 0);
  });
});

describe('handlePendingPrompts (CONS-009)', () => {
  it('processes ask_user_question prompts', () => {
    const msg = {
      sessionId: 'sess1',
      prompts: [
        { type: 'ask_user_question', data: { questions: ['What color?'] } }
      ]
    };
    const results = processPendingPrompts(msg, 'sess1');
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].action, 'structured');
    assert.deepStrictEqual(results[0].data, ['What color?']);
  });

  it('processes permission_request prompts', () => {
    const msg = {
      sessionId: 'sess1',
      prompts: [
        { type: 'permission_request', tool: 'Bash', toolUseId: 'tool-123', data: { input: { command: 'ls' } } }
      ]
    };
    const results = processPendingPrompts(msg, 'sess1');
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].action, 'permission');
    assert.strictEqual(results[0].tool, 'Bash');
    assert.strictEqual(results[0].toolUseId, 'tool-123');
  });

  it('handles mixed prompt types', () => {
    const msg = {
      sessionId: 'sess1',
      prompts: [
        { type: 'ask_user_question', data: { questions: ['Q1'] } },
        { type: 'permission_request', tool: 'Edit', toolUseId: 'tool-456' }
      ]
    };
    const results = processPendingPrompts(msg, 'sess1');
    assert.strictEqual(results.length, 2);
  });

  it('ignores prompts for wrong session', () => {
    const msg = {
      sessionId: 'other',
      prompts: [{ type: 'ask_user_question', data: {} }]
    };
    const results = processPendingPrompts(msg, 'sess1');
    assert.strictEqual(results.length, 0);
  });

  it('handles missing prompts array', () => {
    const results = processPendingPrompts({ sessionId: 'sess1' }, 'sess1');
    assert.strictEqual(results.length, 0);
  });

  it('handles empty prompts array', () => {
    const results = processPendingPrompts({ sessionId: 'sess1', prompts: [] }, 'sess1');
    assert.strictEqual(results.length, 0);
  });

  it('falls back to prompt.data when questions is missing', () => {
    const msg = {
      sessionId: 'sess1',
      prompts: [
        { type: 'ask_user_question', data: { text: 'raw question' } }
      ]
    };
    const results = processPendingPrompts(msg, 'sess1');
    assert.strictEqual(results.length, 1);
    assert.deepStrictEqual(results[0].data, { text: 'raw question' });
  });
});

describe('EXCLUDED_FROM_REPLAY set consistency', () => {
  it('matches the expected server-side exclusion set', () => {
    const expected = ['session_status', 'typing', 'heartbeat', 'session_delta', 'pending_prompts', 'session_suspect', 'session_alive'];
    for (const type of expected) {
      assert.ok(EXCLUDED_FROM_REPLAY.has(type), `Missing type: ${type}`);
    }
    assert.strictEqual(EXCLUDED_FROM_REPLAY.size, expected.length);
  });
});
