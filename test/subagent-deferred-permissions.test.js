const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// =============================================================================
// Replicated subagent deferred-permissions logic from server.js
// (server.js can't be imported directly due to side effects)
// =============================================================================

/**
 * Simulates the subagent watcher's processFileContent() function,
 * specifically the pendingPermissions deferral logic.
 *
 * In server.js, permission_requests from subagents are deferred by one poll
 * cycle to catch auto-approvals (tool_result in the next batch). This test
 * verifies the logic works correctly for batch arrivals.
 */
function processSubagentBatch(allItems, pendingPermissions, resolvedToolUseIds) {
  const broadcasts = [];

  // Phase 1: Resolve any deferred permissions from PREVIOUS batch
  // that now have a tool_result
  for (const [toolUseId] of pendingPermissions) {
    if (resolvedToolUseIds.has(toolUseId)) {
      pendingPermissions.delete(toolUseId);
    }
  }

  // Phase 2: Broadcast deferred permissions that survived (genuinely pending)
  for (const [toolUseId, deferredItem] of pendingPermissions) {
    broadcasts.push({ type: 'subagent_output', data: deferredItem });
    pendingPermissions.delete(toolUseId);
  }

  // Phase 3: Process new items
  for (const item of allItems) {
    // Same-batch auto-approved — skip
    if (item.type === 'permission_request' && item.toolUseId && resolvedToolUseIds.has(item.toolUseId)) {
      continue;
    }

    // Defer permission_request to next cycle
    if (item.type === 'permission_request' && item.toolUseId) {
      pendingPermissions.set(item.toolUseId, item);
      continue;
    }

    // ask_user_question: broadcast immediately
    if (item.type === 'ask_user_question') {
      broadcasts.push({ type: 'subagent_output', data: item });
    }
  }

  return broadcasts;
}

describe('Subagent deferred permissions', () => {

  it('single permission_request is deferred on first batch, broadcast on second', () => {
    const pendingPermissions = new Map();
    const item = { type: 'permission_request', tool: 'Bash', toolUseId: 'tu_1' };

    // Batch 1: permission arrives
    const batch1 = processSubagentBatch([item], pendingPermissions, new Set());
    assert.equal(batch1.length, 0, 'should not broadcast on first batch');
    assert.equal(pendingPermissions.size, 1, 'should be deferred');

    // Batch 2: no new items (fallback poll)
    const batch2 = processSubagentBatch([], pendingPermissions, new Set());
    assert.equal(batch2.length, 1, 'should broadcast on second batch');
    assert.equal(batch2[0].data.toolUseId, 'tu_1');
    assert.equal(pendingPermissions.size, 0, 'should be cleared after broadcast');
  });

  it('5 parallel permissions are ALL deferred then ALL broadcast', () => {
    const pendingPermissions = new Map();
    const items = Array.from({ length: 5 }, (_, i) => ({
      type: 'permission_request',
      tool: 'Read',
      toolUseId: `tu_${i + 1}`
    }));

    // Batch 1: all 5 arrive at once
    const batch1 = processSubagentBatch(items, pendingPermissions, new Set());
    assert.equal(batch1.length, 0, 'none should broadcast on first batch');
    assert.equal(pendingPermissions.size, 5, 'all 5 should be deferred');

    // Batch 2: fallback poll fires (no new content)
    const batch2 = processSubagentBatch([], pendingPermissions, new Set());
    assert.equal(batch2.length, 5, 'all 5 should broadcast on second batch');
    assert.equal(pendingPermissions.size, 0, 'all should be cleared');
    // Verify order preserved
    for (let i = 0; i < 5; i++) {
      assert.equal(batch2[i].data.toolUseId, `tu_${i + 1}`);
    }
  });

  it('auto-approved permission (tool_result in same batch) is not broadcast', () => {
    const pendingPermissions = new Map();
    const items = [
      { type: 'permission_request', tool: 'Read', toolUseId: 'tu_auto' },
      { type: 'tool_result', toolUseId: 'tu_auto', content: 'file contents' }
    ];
    const resolvedIds = new Set(
      items.filter(i => i.type === 'tool_result' && i.toolUseId).map(i => i.toolUseId)
    );

    const batch1 = processSubagentBatch(items, pendingPermissions, resolvedIds);
    assert.equal(batch1.length, 0, 'auto-approved should not broadcast');
    assert.equal(pendingPermissions.size, 0, 'should not be deferred either');
  });

  it('cross-batch auto-approval: deferred then resolved by next batch tool_result', () => {
    const pendingPermissions = new Map();

    // Batch 1: permission arrives
    const batch1 = processSubagentBatch(
      [{ type: 'permission_request', tool: 'Read', toolUseId: 'tu_cross' }],
      pendingPermissions,
      new Set()
    );
    assert.equal(batch1.length, 0);
    assert.equal(pendingPermissions.size, 1);

    // Batch 2: tool_result arrives for same toolUseId
    const resolvedIds = new Set(['tu_cross']);
    const batch2 = processSubagentBatch([], pendingPermissions, resolvedIds);
    assert.equal(batch2.length, 0, 'should be resolved, not broadcast');
    assert.equal(pendingPermissions.size, 0, 'should be removed from pending');
  });

  it('mixed batch: some auto-approved, some deferred', () => {
    const pendingPermissions = new Map();
    const items = [
      { type: 'permission_request', tool: 'Bash', toolUseId: 'tu_bash' },
      { type: 'permission_request', tool: 'Read', toolUseId: 'tu_read' },
      { type: 'tool_result', toolUseId: 'tu_read', content: 'auto-approved' }
    ];
    const resolvedIds = new Set(['tu_read']);

    const batch1 = processSubagentBatch(items, pendingPermissions, resolvedIds);
    assert.equal(batch1.length, 0, 'nothing broadcasts on first batch');
    assert.equal(pendingPermissions.size, 1, 'only Bash should be deferred');
    assert.ok(pendingPermissions.has('tu_bash'));

    // Batch 2: fallback poll
    const batch2 = processSubagentBatch([], pendingPermissions, new Set());
    assert.equal(batch2.length, 1, 'Bash should broadcast');
    assert.equal(batch2[0].data.tool, 'Bash');
  });

  it('ask_user_question is broadcast immediately (not deferred)', () => {
    const pendingPermissions = new Map();
    const items = [
      { type: 'ask_user_question', questions: [{ question: 'Pick?' }] },
      { type: 'permission_request', tool: 'Bash', toolUseId: 'tu_q' }
    ];

    const batch1 = processSubagentBatch(items, pendingPermissions, new Set());
    assert.equal(batch1.length, 1, 'question should broadcast immediately');
    assert.equal(batch1[0].data.type, 'ask_user_question');
    assert.equal(pendingPermissions.size, 1, 'permission should be deferred');
  });

  it('permission_request without toolUseId is not deferred (no key)', () => {
    const pendingPermissions = new Map();
    const item = { type: 'permission_request', tool: 'Bash', toolUseId: null };

    // null toolUseId → the `if (item.toolUseId)` guard prevents deferral
    const batch1 = processSubagentBatch([item], pendingPermissions, new Set());
    // With null toolUseId, the deferral is skipped — item is silently dropped
    assert.equal(batch1.length, 0, 'should not broadcast without toolUseId');
    assert.equal(pendingPermissions.size, 0, 'should not defer without toolUseId');
  });

  it('fallback poll with no pending and no new items is a no-op', () => {
    const pendingPermissions = new Map();
    const batch = processSubagentBatch([], pendingPermissions, new Set());
    assert.equal(batch.length, 0);
    assert.equal(pendingPermissions.size, 0);
  });

  it('repeated fallback polls after flush produce no duplicates', () => {
    const pendingPermissions = new Map();
    const item = { type: 'permission_request', tool: 'Bash', toolUseId: 'tu_once' };

    // Batch 1: defer
    processSubagentBatch([item], pendingPermissions, new Set());
    assert.equal(pendingPermissions.size, 1);

    // Batch 2: flush
    const batch2 = processSubagentBatch([], pendingPermissions, new Set());
    assert.equal(batch2.length, 1);

    // Batch 3+: no more broadcasts
    const batch3 = processSubagentBatch([], pendingPermissions, new Set());
    assert.equal(batch3.length, 0);
    const batch4 = processSubagentBatch([], pendingPermissions, new Set());
    assert.equal(batch4.length, 0);
  });
});
