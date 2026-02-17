const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// =============================================================================
// Replicated server.js logic for testing
// (server.js can't be imported directly due to side effects)
// =============================================================================

const MAX_MILESTONES = 20;

function detectMilestone(item, sessionData) {
  if (!sessionData) return null;
  if (item.type === 'tool' || item.type === 'permission_request' ||
      (item.type === 'status_update' && item.tool)) {
    sessionData.toolBurstCount++;
    return null;
  }
  if (item.type === 'assistant' && sessionData.toolBurstCount >= 2) {
    const milestone = {
      text: item.content || '',
      timestamp: item.timestamp || new Date().toISOString(),
      toolCount: sessionData.toolBurstCount
    };
    sessionData.milestones.push(milestone);
    while (sessionData.milestones.length > MAX_MILESTONES) {
      sessionData.milestones.shift();
    }
    sessionData.toolBurstCount = 0;
    return milestone;
  }
  if (item.type === 'assistant' || item.type === 'user') {
    sessionData.toolBurstCount = 0;
  }
  return null;
}

function createSessionData() {
  return {
    milestones: [],
    toolBurstCount: 0,
    activeTeam: null,
    teamMessages: [],
    mode: 'default',
    lastStatus: 'idle',
    subagentInfo: new Map(),
    tasks: new Map()
  };
}

/**
 * Simulates broadcastToClients with the try/catch fix.
 * Returns { sent: messages[], errors: count }
 */
function broadcastToClients(message, clients) {
  const data = JSON.stringify(message);
  const result = { sent: [], errors: 0 };
  for (const { ws, clientData } of clients) {
    if (ws.readyState === 'OPEN' && !clientData.pauseBroadcast) {
      if (!message.sessionId || clientData.watchingSessions.has(message.sessionId)) {
        try {
          ws.send(data);
          result.sent.push(data);
        } catch (e) {
          result.errors++;
        }
      }
    }
  }
  return result;
}

/**
 * Simulates the full watcher broadcast loop + milestone detection,
 * replicating the exact control flow from processLogChanges() in server.js.
 * Returns { lastPosition, broadcasts, milestoneErrors }
 */
function simulateWatcherProcessing(filteredItems, sessionId, sessionData, broadcastFn, initialPosition, consumedBytes) {
  let lastPosition = initialPosition;
  const broadcasts = [];
  let milestoneErrors = 0;

  // Broadcast loop (lines 524-620 in server.js)
  for (const item of filteredItems) {
    if (item.type === 'mode_change') {
      if (sessionData && sessionData.mode !== item.mode) {
        sessionData.mode = item.mode;
        broadcastFn({ type: 'mode_change', sessionId, mode: item.mode });
        broadcasts.push({ type: 'mode_change' });
      }
    } else if (item.type === 'subagent_starting') {
      broadcastFn({ type: 'subagent_starting', sessionId, description: item.description });
      broadcasts.push({ type: 'subagent_starting' });
    } else if (item.type === 'permission_resolved') {
      broadcastFn({ type: 'permission_resolved', sessionId, toolUseId: item.toolUseId });
      broadcasts.push({ type: 'permission_resolved' });
    } else if (item.type === 'task_create' || item.type === 'task_update' || item.type === 'task_list') {
      broadcastFn(Object.assign({}, item, { sessionId }));
      broadcasts.push({ type: item.type });
    } else if (item.type === 'team_create') {
      if (sessionData) {
        sessionData.activeTeam = { name: item.teamName, members: new Map(), createdAt: item.timestamp };
        sessionData.teamMessages = [];
      }
      broadcastFn({ type: 'team_create', sessionId, teamName: item.teamName });
      broadcasts.push({ type: 'team_create' });
    } else if (item.type === 'team_delete') {
      if (sessionData) {
        sessionData.activeTeam = null;
        sessionData.teamMessages = [];
      }
      broadcastFn({ type: 'team_delete', sessionId });
      broadcasts.push({ type: 'team_delete' });
    } else if (item.type === 'team_message') {
      if (sessionData) {
        sessionData.teamMessages.push({
          sender: item.sender, recipient: item.recipient,
          content: item.content, messageType: item.messageType
        });
        if (sessionData.teamMessages.length > 50) {
          sessionData.teamMessages = sessionData.teamMessages.slice(-50);
        }
      }
      broadcastFn({ type: 'team_message', sessionId, sender: item.sender, content: item.content });
      broadcasts.push({ type: 'team_message' });
    } else {
      broadcastFn({ type: 'claude_output', sessionId, data: item });
      broadcasts.push({ type: 'claude_output', itemType: item.type });
    }
  }

  // CRITICAL FIX: advance position BEFORE milestone detection
  lastPosition += consumedBytes;

  // Milestone detection with try/catch (lines 622-640 in server.js)
  try {
    if (sessionData) {
      for (const item of filteredItems) {
        const milestone = detectMilestone(item, sessionData);
        if (milestone) {
          broadcastFn({
            type: 'session_milestone', sessionId,
            text: milestone.text, timestamp: milestone.timestamp, toolCount: milestone.toolCount
          });
          broadcasts.push({ type: 'session_milestone' });
        }
      }
    }
  } catch (e) {
    milestoneErrors++;
  }

  return { lastPosition, broadcasts, milestoneErrors };
}

// =============================================================================
// Tests: Watcher position resilience
// =============================================================================

describe('Watcher position resilience', () => {
  it('lastPosition advances even when milestone detection would throw', () => {
    // Simulate a scenario where detectMilestone throws by passing
    // a corrupted sessionData (milestones is not an array)
    const badSessionData = {
      milestones: 'not-an-array', // This will cause .push() to throw
      toolBurstCount: 5 // High count so milestone triggers
    };
    const items = [{ type: 'assistant', content: 'Done.', timestamp: 'T1' }];
    const noop = () => {};

    const result = simulateWatcherProcessing(items, 'sess-1', badSessionData, noop, 1000, 500);

    // Position MUST advance regardless of milestone error
    assert.equal(result.lastPosition, 1500, 'lastPosition must advance even on milestone error');
    assert.equal(result.milestoneErrors, 1, 'should have caught the milestone error');
  });

  it('lastPosition advances when sessionData is null', () => {
    const items = [
      { type: 'tool', tool: 'Read' },
      { type: 'assistant', content: 'Found it.' }
    ];
    const noop = () => {};

    const result = simulateWatcherProcessing(items, 'sess-1', null, noop, 2000, 300);

    assert.equal(result.lastPosition, 2300);
    assert.equal(result.milestoneErrors, 0);
  });

  it('lastPosition advances when filteredItems is empty', () => {
    const noop = () => {};
    const sd = createSessionData();
    const result = simulateWatcherProcessing([], 'sess-1', sd, noop, 5000, 100);

    assert.equal(result.lastPosition, 5100);
    assert.equal(result.milestoneErrors, 0);
  });

  it('position advances correctly across multiple batches', () => {
    const sd = createSessionData();
    const noop = () => {};

    // Batch 1
    const r1 = simulateWatcherProcessing(
      [{ type: 'tool', tool: 'Read' }, { type: 'tool', tool: 'Grep' }],
      'sess-1', sd, noop, 0, 1000
    );
    assert.equal(r1.lastPosition, 1000);

    // Batch 2 — assistant triggers milestone
    const r2 = simulateWatcherProcessing(
      [{ type: 'assistant', content: 'Found results.', timestamp: 'T1' }],
      'sess-1', sd, noop, r1.lastPosition, 500
    );
    assert.equal(r2.lastPosition, 1500);
    assert.equal(sd.milestones.length, 1);

    // Batch 3
    const r3 = simulateWatcherProcessing(
      [{ type: 'user', content: 'Thanks' }],
      'sess-1', sd, noop, r2.lastPosition, 200
    );
    assert.equal(r3.lastPosition, 1700);
  });
});

// =============================================================================
// Tests: broadcastToClients error safety
// =============================================================================

describe('broadcastToClients error safety', () => {
  it('skips clients where ws.send() throws', () => {
    const clients = [
      {
        ws: {
          readyState: 'OPEN',
          send: () => { throw new Error('Connection closing'); }
        },
        clientData: { pauseBroadcast: false, watchingSessions: new Set(['sess-1']) }
      },
      {
        ws: {
          readyState: 'OPEN',
          send: (data) => { /* success */ }
        },
        clientData: { pauseBroadcast: false, watchingSessions: new Set(['sess-1']) }
      }
    ];

    const result = broadcastToClients({ type: 'claude_output', sessionId: 'sess-1', data: {} }, clients);
    assert.equal(result.sent.length, 1, 'one client should succeed');
    assert.equal(result.errors, 1, 'one client should error');
  });

  it('skips clients with pauseBroadcast = true', () => {
    const sent = [];
    const clients = [
      {
        ws: { readyState: 'OPEN', send: (d) => sent.push(d) },
        clientData: { pauseBroadcast: true, watchingSessions: new Set(['sess-1']) }
      },
      {
        ws: { readyState: 'OPEN', send: (d) => sent.push(d) },
        clientData: { pauseBroadcast: false, watchingSessions: new Set(['sess-1']) }
      }
    ];

    broadcastToClients({ type: 'test', sessionId: 'sess-1' }, clients);
    assert.equal(sent.length, 1, 'only non-paused client should receive');
  });

  it('skips clients not watching the session', () => {
    const sent = [];
    const clients = [
      {
        ws: { readyState: 'OPEN', send: (d) => sent.push(d) },
        clientData: { pauseBroadcast: false, watchingSessions: new Set(['other-session']) }
      }
    ];

    broadcastToClients({ type: 'test', sessionId: 'sess-1' }, clients);
    assert.equal(sent.length, 0, 'client watching different session should not receive');
  });

  it('sends to all matching clients when no errors', () => {
    const sent = [];
    const clients = [
      {
        ws: { readyState: 'OPEN', send: (d) => sent.push('c1') },
        clientData: { pauseBroadcast: false, watchingSessions: new Set(['sess-1']) }
      },
      {
        ws: { readyState: 'OPEN', send: (d) => sent.push('c2') },
        clientData: { pauseBroadcast: false, watchingSessions: new Set(['sess-1']) }
      },
      {
        ws: { readyState: 'OPEN', send: (d) => sent.push('c3') },
        clientData: { pauseBroadcast: false, watchingSessions: new Set(['sess-1']) }
      }
    ];

    const result = broadcastToClients({ type: 'test', sessionId: 'sess-1' }, clients);
    assert.equal(result.sent.length, 3);
    assert.equal(result.errors, 0);
  });

  it('sends messages without sessionId to all open clients', () => {
    const sent = [];
    const clients = [
      {
        ws: { readyState: 'OPEN', send: (d) => sent.push('c1') },
        clientData: { pauseBroadcast: false, watchingSessions: new Set() }
      },
      {
        ws: { readyState: 'OPEN', send: (d) => sent.push('c2') },
        clientData: { pauseBroadcast: false, watchingSessions: new Set(['sess-1']) }
      }
    ];

    broadcastToClients({ type: 'sessions', data: [] }, clients);
    assert.equal(sent.length, 2, 'messages without sessionId go to all clients');
  });

  it('skips clients with readyState != OPEN', () => {
    const sent = [];
    const clients = [
      {
        ws: { readyState: 'CLOSING', send: (d) => sent.push(d) },
        clientData: { pauseBroadcast: false, watchingSessions: new Set(['sess-1']) }
      },
      {
        ws: { readyState: 'CLOSED', send: (d) => sent.push(d) },
        clientData: { pauseBroadcast: false, watchingSessions: new Set(['sess-1']) }
      }
    ];

    broadcastToClients({ type: 'test', sessionId: 'sess-1' }, clients);
    assert.equal(sent.length, 0);
  });

  it('handles JSON.stringify with complex nested data', () => {
    const sent = [];
    const clients = [{
      ws: { readyState: 'OPEN', send: (d) => sent.push(JSON.parse(d)) },
      clientData: { pauseBroadcast: false, watchingSessions: new Set(['sess-1']) }
    }];

    broadcastToClients({
      type: 'claude_output',
      sessionId: 'sess-1',
      data: {
        type: 'assistant',
        content: 'Text with unicode: 🌍 café résumé\nMultiline\ttabs',
        tool: null,
        input: { nested: { deep: [1, 2, 3] } }
      }
    }, clients);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].data.content, 'Text with unicode: 🌍 café résumé\nMultiline\ttabs');
  });
});

// =============================================================================
// Tests: Broadcast routing (if/else chain correctness)
// =============================================================================

describe('Broadcast routing', () => {
  it('routes assistant items to claude_output', () => {
    const sd = createSessionData();
    const broadcasts = [];
    const broadcastFn = (msg) => broadcasts.push(msg);

    simulateWatcherProcessing(
      [{ type: 'assistant', content: 'Hello world', timestamp: 'T1' }],
      'sess-1', sd, broadcastFn, 0, 100
    );

    const outputMsgs = broadcasts.filter(b => b.type === 'claude_output');
    assert.equal(outputMsgs.length, 1);
    assert.equal(outputMsgs[0].data.content, 'Hello world');
  });

  it('routes tool items to claude_output', () => {
    const sd = createSessionData();
    const broadcasts = [];
    const broadcastFn = (msg) => broadcasts.push(msg);

    simulateWatcherProcessing(
      [{ type: 'tool', tool: 'Read', input: {}, timestamp: 'T1' }],
      'sess-1', sd, broadcastFn, 0, 100
    );

    const outputMsgs = broadcasts.filter(b => b.type === 'claude_output');
    assert.equal(outputMsgs.length, 1);
    assert.equal(outputMsgs[0].data.tool, 'Read');
  });

  it('routes permission_request to claude_output (not intercepted)', () => {
    const sd = createSessionData();
    const broadcasts = [];
    const broadcastFn = (msg) => broadcasts.push(msg);

    simulateWatcherProcessing(
      [{ type: 'permission_request', tool: 'Bash', toolUseId: 'tu-1' }],
      'sess-1', sd, broadcastFn, 0, 100
    );

    const outputMsgs = broadcasts.filter(b => b.type === 'claude_output');
    assert.equal(outputMsgs.length, 1);
  });

  it('routes user items to claude_output', () => {
    const sd = createSessionData();
    const broadcasts = [];
    const broadcastFn = (msg) => broadcasts.push(msg);

    simulateWatcherProcessing(
      [{ type: 'user', content: 'Hello' }],
      'sess-1', sd, broadcastFn, 0, 100
    );

    assert.ok(broadcasts.some(b => b.type === 'claude_output'));
  });

  it('routes mode_change as top-level message', () => {
    const sd = createSessionData();
    const broadcasts = [];
    const broadcastFn = (msg) => broadcasts.push(msg);

    simulateWatcherProcessing(
      [{ type: 'mode_change', mode: 'plan' }],
      'sess-1', sd, broadcastFn, 0, 100
    );

    assert.ok(broadcasts.some(b => b.type === 'mode_change' && b.mode === 'plan'));
    assert.ok(!broadcasts.some(b => b.type === 'claude_output'));
    assert.equal(sd.mode, 'plan');
  });

  it('does not broadcast mode_change if mode unchanged', () => {
    const sd = createSessionData();
    sd.mode = 'plan';
    const broadcasts = [];
    const broadcastFn = (msg) => broadcasts.push(msg);

    simulateWatcherProcessing(
      [{ type: 'mode_change', mode: 'plan' }],
      'sess-1', sd, broadcastFn, 0, 100
    );

    assert.equal(broadcasts.length, 0, 'no broadcast when mode is unchanged');
  });

  it('routes subagent_starting as top-level message', () => {
    const sd = createSessionData();
    const broadcasts = [];
    const broadcastFn = (msg) => broadcasts.push(msg);

    simulateWatcherProcessing(
      [{ type: 'subagent_starting', description: 'Explore codebase', agentType: 'general' }],
      'sess-1', sd, broadcastFn, 0, 100
    );

    assert.ok(broadcasts.some(b => b.type === 'subagent_starting'));
    assert.ok(!broadcasts.some(b => b.type === 'claude_output'));
  });

  it('routes permission_resolved as top-level message', () => {
    const sd = createSessionData();
    const broadcasts = [];
    const broadcastFn = (msg) => broadcasts.push(msg);

    simulateWatcherProcessing(
      [{ type: 'permission_resolved', toolUseId: 'tu-123' }],
      'sess-1', sd, broadcastFn, 0, 100
    );

    assert.ok(broadcasts.some(b => b.type === 'permission_resolved' && b.toolUseId === 'tu-123'));
  });

  it('routes task_create as top-level message', () => {
    const sd = createSessionData();
    const broadcasts = [];
    const broadcastFn = (msg) => broadcasts.push(msg);

    simulateWatcherProcessing(
      [{ type: 'task_create', id: '1', subject: 'Fix bug', status: 'pending' }],
      'sess-1', sd, broadcastFn, 0, 100
    );

    assert.ok(broadcasts.some(b => b.type === 'task_create' && b.subject === 'Fix bug'));
  });

  it('routes task_update as top-level message', () => {
    const sd = createSessionData();
    const broadcasts = [];
    const broadcastFn = (msg) => broadcasts.push(msg);

    simulateWatcherProcessing(
      [{ type: 'task_update', taskId: '1', status: 'completed' }],
      'sess-1', sd, broadcastFn, 0, 100
    );

    assert.ok(broadcasts.some(b => b.type === 'task_update'));
  });

  it('routes task_list as top-level message', () => {
    const sd = createSessionData();
    const broadcasts = [];
    const broadcastFn = (msg) => broadcasts.push(msg);

    simulateWatcherProcessing(
      [{ type: 'task_list', tasks: [{ id: '1', subject: 'Test', status: 'pending' }] }],
      'sess-1', sd, broadcastFn, 0, 100
    );

    assert.ok(broadcasts.some(b => b.type === 'task_list'));
  });

  it('routes team_create as top-level and updates sessionData', () => {
    const sd = createSessionData();
    const broadcasts = [];
    const broadcastFn = (msg) => broadcasts.push(msg);

    simulateWatcherProcessing(
      [{ type: 'team_create', teamName: 'review-team', timestamp: 'T1' }],
      'sess-1', sd, broadcastFn, 0, 100
    );

    assert.ok(broadcasts.some(b => b.type === 'team_create' && b.teamName === 'review-team'));
    assert.notEqual(sd.activeTeam, null);
    assert.equal(sd.activeTeam.name, 'review-team');
    assert.equal(sd.teamMessages.length, 0);
  });

  it('routes team_delete as top-level and clears team state', () => {
    const sd = createSessionData();
    sd.activeTeam = { name: 'old-team', members: new Map() };
    sd.teamMessages = [{ sender: 'a', content: 'msg' }];
    const broadcasts = [];
    const broadcastFn = (msg) => broadcasts.push(msg);

    simulateWatcherProcessing(
      [{ type: 'team_delete', timestamp: 'T1' }],
      'sess-1', sd, broadcastFn, 0, 100
    );

    assert.ok(broadcasts.some(b => b.type === 'team_delete'));
    assert.equal(sd.activeTeam, null);
    assert.equal(sd.teamMessages.length, 0);
  });

  it('routes team_message as top-level and accumulates', () => {
    const sd = createSessionData();
    const broadcasts = [];
    const broadcastFn = (msg) => broadcasts.push(msg);

    simulateWatcherProcessing(
      [{ type: 'team_message', sender: 'lead', recipient: 'worker', content: 'Do task 1', messageType: 'message', timestamp: 'T1' }],
      'sess-1', sd, broadcastFn, 0, 100
    );

    assert.ok(broadcasts.some(b => b.type === 'team_message' && b.content === 'Do task 1'));
    assert.equal(sd.teamMessages.length, 1);
    assert.equal(sd.teamMessages[0].sender, 'lead');
  });

  it('caps team messages at 50', () => {
    const sd = createSessionData();
    const noop = () => {};
    const items = [];
    for (let i = 0; i < 55; i++) {
      items.push({ type: 'team_message', sender: 'agent', recipient: null, content: `msg-${i}`, messageType: 'broadcast', timestamp: `T${i}` });
    }

    simulateWatcherProcessing(items, 'sess-1', sd, noop, 0, 5000);

    assert.equal(sd.teamMessages.length, 50);
    assert.equal(sd.teamMessages[0].content, 'msg-5');
    assert.equal(sd.teamMessages[49].content, 'msg-54');
  });

  it('compaction_complete routes to claude_output (else branch)', () => {
    const sd = createSessionData();
    const broadcasts = [];
    const broadcastFn = (msg) => broadcasts.push(msg);

    simulateWatcherProcessing(
      [{ type: 'compaction_complete', content: 'Context compacted', timestamp: 'T1' }],
      'sess-1', sd, broadcastFn, 0, 100
    );

    const output = broadcasts.find(b => b.type === 'claude_output');
    assert.ok(output, 'compaction_complete should route to claude_output');
    assert.equal(output.data.type, 'compaction_complete');
  });

  it('status_update routes to claude_output', () => {
    const sd = createSessionData();
    const broadcasts = [];
    const broadcastFn = (msg) => broadcasts.push(msg);

    simulateWatcherProcessing(
      [{ type: 'status_update', content: 'Thinking...', timestamp: 'T1' }],
      'sess-1', sd, broadcastFn, 0, 100
    );

    assert.ok(broadcasts.some(b => b.type === 'claude_output' && b.data.type === 'status_update'));
  });

  it('ask_user_question routes to claude_output', () => {
    const sd = createSessionData();
    const broadcasts = [];
    const broadcastFn = (msg) => broadcasts.push(msg);

    simulateWatcherProcessing(
      [{ type: 'ask_user_question', questions: [{ question: 'Pick one' }], timestamp: 'T1' }],
      'sess-1', sd, broadcastFn, 0, 100
    );

    assert.ok(broadcasts.some(b => b.type === 'claude_output' && b.data.type === 'ask_user_question'));
  });

  it('unknown type routes to claude_output (catch-all else)', () => {
    const sd = createSessionData();
    const broadcasts = [];
    const broadcastFn = (msg) => broadcasts.push(msg);

    simulateWatcherProcessing(
      [{ type: 'some_future_type', content: 'data' }],
      'sess-1', sd, broadcastFn, 0, 100
    );

    assert.ok(broadcasts.some(b => b.type === 'claude_output' && b.data.type === 'some_future_type'));
  });
});

// =============================================================================
// Tests: Milestone detection in watcher context
// =============================================================================

describe('Milestone detection in watcher', () => {
  it('detects milestones after broadcast loop completes', () => {
    const sd = createSessionData();
    const broadcasts = [];
    const broadcastFn = (msg) => broadcasts.push(msg);

    const items = [
      { type: 'tool', tool: 'Read', timestamp: 'T1' },
      { type: 'tool', tool: 'Edit', timestamp: 'T2' },
      { type: 'assistant', content: 'Updated the file.', timestamp: 'T3' }
    ];

    simulateWatcherProcessing(items, 'sess-1', sd, broadcastFn, 0, 1000);

    // Should have claude_output broadcasts AND a session_milestone
    const outputs = broadcasts.filter(b => b.type === 'claude_output');
    const milestones = broadcasts.filter(b => b.type === 'session_milestone');
    assert.equal(outputs.length, 3, '3 items should produce 3 claude_outputs');
    assert.equal(milestones.length, 1, 'should detect 1 milestone');
    assert.equal(milestones[0].text, 'Updated the file.');
    assert.equal(milestones[0].toolCount, 2);
  });

  it('no milestone when tool burst < 2', () => {
    const sd = createSessionData();
    const broadcasts = [];
    const broadcastFn = (msg) => broadcasts.push(msg);

    simulateWatcherProcessing(
      [
        { type: 'tool', tool: 'Read', timestamp: 'T1' },
        { type: 'assistant', content: 'Here it is.', timestamp: 'T2' }
      ],
      'sess-1', sd, broadcastFn, 0, 500
    );

    assert.ok(!broadcasts.some(b => b.type === 'session_milestone'));
  });

  it('multiple milestones in a single batch', () => {
    const sd = createSessionData();
    const broadcasts = [];
    const broadcastFn = (msg) => broadcasts.push(msg);

    const items = [
      { type: 'tool', tool: 'Read' },
      { type: 'tool', tool: 'Grep' },
      { type: 'assistant', content: 'Found the issue.', timestamp: 'T1' },
      { type: 'tool', tool: 'Edit' },
      { type: 'tool', tool: 'Bash' },
      { type: 'tool', tool: 'Read' },
      { type: 'assistant', content: 'Fixed and tested.', timestamp: 'T2' }
    ];

    simulateWatcherProcessing(items, 'sess-1', sd, broadcastFn, 0, 2000);

    const milestones = broadcasts.filter(b => b.type === 'session_milestone');
    assert.equal(milestones.length, 2);
    assert.equal(milestones[0].text, 'Found the issue.');
    assert.equal(milestones[0].toolCount, 2);
    assert.equal(milestones[1].text, 'Fixed and tested.');
    assert.equal(milestones[1].toolCount, 3);
  });

  it('milestone detection error does not affect position or broadcasts', () => {
    // Corrupt sessionData to force milestone detection error
    const sd = createSessionData();
    Object.defineProperty(sd, 'milestones', {
      get() { throw new Error('corrupted milestones'); }
    });

    const broadcasts = [];
    const broadcastFn = (msg) => broadcasts.push(msg);

    const items = [
      { type: 'tool', tool: 'Read' },
      { type: 'tool', tool: 'Edit' },
      { type: 'assistant', content: 'Done.', timestamp: 'T1' }
    ];

    const result = simulateWatcherProcessing(items, 'sess-1', sd, broadcastFn, 5000, 800);

    // Position MUST advance
    assert.equal(result.lastPosition, 5800);
    // Broadcast loop should have completed (3 claude_output messages)
    const outputs = broadcasts.filter(b => b.type === 'claude_output');
    assert.equal(outputs.length, 3, 'broadcast loop should complete before milestone detection');
    // Milestone error should be caught
    assert.equal(result.milestoneErrors, 1);
  });

  it('tool burst state persists across batches', () => {
    const sd = createSessionData();
    const noop = () => {};

    // Batch 1: 2 tools, no assistant
    simulateWatcherProcessing(
      [{ type: 'tool', tool: 'Read' }, { type: 'tool', tool: 'Grep' }],
      'sess-1', sd, noop, 0, 500
    );
    assert.equal(sd.toolBurstCount, 2);

    // Batch 2: 1 more tool + assistant → should trigger milestone (3 tools total)
    const broadcasts = [];
    simulateWatcherProcessing(
      [{ type: 'tool', tool: 'Edit' }, { type: 'assistant', content: 'All done.', timestamp: 'T1' }],
      'sess-1', sd, (msg) => broadcasts.push(msg), 500, 300
    );

    assert.equal(sd.milestones.length, 1);
    assert.equal(sd.milestones[0].toolCount, 3);
  });

  it('user message resets tool burst across batches', () => {
    const sd = createSessionData();
    const noop = () => {};

    // Batch 1: 3 tools
    simulateWatcherProcessing(
      [{ type: 'tool', tool: 'A' }, { type: 'tool', tool: 'B' }, { type: 'tool', tool: 'C' }],
      'sess-1', sd, noop, 0, 500
    );
    assert.equal(sd.toolBurstCount, 3);

    // Batch 2: user message resets burst, then assistant — no milestone
    simulateWatcherProcessing(
      [{ type: 'user', content: 'Stop' }, { type: 'assistant', content: 'OK' }],
      'sess-1', sd, noop, 500, 200
    );
    assert.equal(sd.toolBurstCount, 0);
    assert.equal(sd.milestones.length, 0);
  });
});

// =============================================================================
// Tests: Mixed routing (realistic message sequences)
// =============================================================================

describe('Realistic message sequences', () => {
  it('typical Claude session: assistant + tools + milestone', () => {
    const sd = createSessionData();
    const broadcasts = [];
    const broadcastFn = (msg) => broadcasts.push(msg);

    const items = [
      { type: 'assistant', content: 'Let me check the code.', timestamp: 'T1' },
      { type: 'status_update', content: 'Searching...', tool: 'Grep', timestamp: 'T2' },
      { type: 'tool', tool: 'Grep', input: { pattern: 'foo' }, timestamp: 'T3' },
      { type: 'status_update', content: 'Reading...', tool: 'Read', timestamp: 'T4' },
      { type: 'tool', tool: 'Read', input: { file: 'bar.js' }, timestamp: 'T5' },
      { type: 'assistant', content: 'I found the issue in bar.js.', timestamp: 'T6' },
      { type: 'status_update', content: 'Editing...', tool: 'Edit', timestamp: 'T7' },
      { type: 'tool', tool: 'Edit', input: { file: 'bar.js' }, timestamp: 'T8' },
      { type: 'assistant', content: 'Fixed the bug.', timestamp: 'T9' }
    ];

    const result = simulateWatcherProcessing(items, 'sess-1', sd, broadcastFn, 0, 5000);

    // All items should route to claude_output
    const outputs = broadcasts.filter(b => b.type === 'claude_output');
    assert.equal(outputs.length, 9);

    // Milestones: T6 assistant after 4 tool-like items (2 status_update+tool, 2 tool)
    // Actually: status_update with tool field counts, regular tool counts
    // T2 (status_update+tool): burst=1, T3 (tool): burst=2, T4 (status_update+tool): burst=3, T5 (tool): burst=4
    // T6 (assistant after burst=4): MILESTONE
    // T7 (status_update+tool): burst=1, T8 (tool): burst=2
    // T9 (assistant after burst=2): MILESTONE (but only 1 tool after T6 reset... wait no)
    // After T6 milestone: burst resets to 0
    // T7: burst=1, T8: burst=2
    // T9 assistant with burst=2: MILESTONE
    const milestones = broadcasts.filter(b => b.type === 'session_milestone');
    assert.equal(milestones.length, 2);
    assert.equal(milestones[0].text, 'I found the issue in bar.js.');
    assert.equal(milestones[1].text, 'Fixed the bug.');

    assert.equal(result.lastPosition, 5000);
  });

  it('team session: create + messages + delete', () => {
    const sd = createSessionData();
    const broadcasts = [];
    const broadcastFn = (msg) => broadcasts.push(msg);

    const items = [
      { type: 'assistant', content: 'Setting up a team.', timestamp: 'T1' },
      { type: 'team_create', teamName: 'impl-team', timestamp: 'T2' },
      { type: 'team_message', sender: 'lead', recipient: 'worker-1', content: 'Start on auth', messageType: 'message', timestamp: 'T3' },
      { type: 'team_message', sender: 'lead', recipient: 'worker-2', content: 'Start on UI', messageType: 'message', timestamp: 'T4' },
      { type: 'assistant', content: 'Team is working.', timestamp: 'T5' },
      { type: 'team_delete', timestamp: 'T6' },
      { type: 'assistant', content: 'Team finished.', timestamp: 'T7' }
    ];

    simulateWatcherProcessing(items, 'sess-1', sd, broadcastFn, 0, 3000);

    // Check broadcast types
    assert.ok(broadcasts.some(b => b.type === 'team_create'));
    assert.equal(broadcasts.filter(b => b.type === 'team_message').length, 2);
    assert.ok(broadcasts.some(b => b.type === 'team_delete'));
    // assistant messages go to claude_output
    assert.equal(broadcasts.filter(b => b.type === 'claude_output').length, 3);

    // After team_delete, team state should be cleared
    assert.equal(sd.activeTeam, null);
    assert.equal(sd.teamMessages.length, 0);
  });

  it('mixed batch: tasks + team + regular output', () => {
    const sd = createSessionData();
    const broadcasts = [];
    const broadcastFn = (msg) => broadcasts.push(msg);

    const items = [
      { type: 'task_create', id: '1', subject: 'Fix auth', status: 'pending' },
      { type: 'team_create', teamName: 'fix-team', timestamp: 'T1' },
      { type: 'assistant', content: 'Working on it.', timestamp: 'T2' },
      { type: 'task_update', taskId: '1', status: 'in_progress' },
      { type: 'team_message', sender: 'lead', recipient: 'analyst', content: 'Check logs', messageType: 'message', timestamp: 'T3' },
      { type: 'mode_change', mode: 'plan' }
    ];

    simulateWatcherProcessing(items, 'sess-1', sd, broadcastFn, 0, 2000);

    // Each type should route correctly
    assert.ok(broadcasts.some(b => b.type === 'task_create'));
    assert.ok(broadcasts.some(b => b.type === 'team_create'));
    assert.ok(broadcasts.some(b => b.type === 'claude_output'));
    assert.ok(broadcasts.some(b => b.type === 'task_update'));
    assert.ok(broadcasts.some(b => b.type === 'team_message'));
    assert.ok(broadcasts.some(b => b.type === 'mode_change'));

    // No type should accidentally be claude_output
    const outputs = broadcasts.filter(b => b.type === 'claude_output');
    assert.equal(outputs.length, 1, 'only assistant should be claude_output');
    assert.equal(outputs[0].data.type, 'assistant');
  });
});
