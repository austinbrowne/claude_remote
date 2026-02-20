const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// =============================================================================
// Replicated main-watcher deferred-permissions logic from lib/watcher.js
// (server modules can't be imported directly due to side effects)
// =============================================================================

/**
 * Simulates the main session watcher's three-phase permission deferral logic
 * inside processLogChanges(). Unlike the subagent watcher, the main watcher:
 *   - Converts same-batch auto-approved permission_requests to type:'tool'
 *     (so clients can pair them with tool_results)
 *   - Broadcasts all non-permission items as claude_output
 *   - Broadcasts deferred permissions as claude_output on the next poll cycle
 *   - Falls through permission_requests without toolUseId immediately
 */
function processMainBatch(allItems, pendingMainPermissions) {
  const broadcasts = [];

  // Phase 1: Collect resolved toolUseIds from this batch
  const resolvedToolUseIds = new Set(
    allItems
      .filter(i => i.type === 'tool_result' && i.toolUseId)
      .map(i => i.toolUseId)
  );

  // Phase 2: Flush deferred permissions from previous poll cycle
  for (const [toolUseId] of pendingMainPermissions) {
    if (resolvedToolUseIds.has(toolUseId)) {
      pendingMainPermissions.delete(toolUseId);
    }
  }
  for (const [toolUseId, deferredItem] of pendingMainPermissions) {
    broadcasts.push({ type: 'claude_output', data: deferredItem });
    pendingMainPermissions.delete(toolUseId);
  }

  // Phase 3: Classify new items
  const filteredItems = [];
  for (const item of allItems) {
    if (item.type === 'permission_request' && item.toolUseId) {
      if (resolvedToolUseIds.has(item.toolUseId)) {
        // Same-batch auto-approved: convert to regular tool
        filteredItems.push({ ...item, type: 'tool' });
      } else {
        // Defer to next poll cycle
        pendingMainPermissions.set(item.toolUseId, item);
      }
    } else if (item.type === 'permission_request' && !item.toolUseId) {
      // No toolUseId — can't defer, broadcast immediately
      filteredItems.push(item);
    } else {
      filteredItems.push(item);
    }
  }

  // Broadcast filtered items (simulates the for-loop over filteredItems)
  for (const item of filteredItems) {
    broadcasts.push({ type: 'claude_output', data: item });
  }

  return broadcasts;
}

describe('Main watcher deferred permissions', () => {

  it('same-batch auto-approved permission is converted to type:tool', () => {
    const pending = new Map();
    const items = [
      { type: 'permission_request', tool: 'Read', toolUseId: 'tu_auto' },
      { type: 'tool_result', toolUseId: 'tu_auto', content: 'file contents' }
    ];

    const broadcasts = processMainBatch(items, pending);
    assert.equal(pending.size, 0, 'should not be deferred');

    // Find the converted item
    const converted = broadcasts.find(b => b.data.toolUseId === 'tu_auto' && b.data.type === 'tool');
    assert.ok(converted, 'permission_request should be converted to type:tool');
    assert.equal(converted.data.tool, 'Read');

    // tool_result also passes through
    const result = broadcasts.find(b => b.data.type === 'tool_result');
    assert.ok(result, 'tool_result should pass through');
  });

  it('cross-batch deferred permission broadcasts on second poll cycle', () => {
    const pending = new Map();

    // Batch 1: permission arrives without matching tool_result
    const batch1 = processMainBatch(
      [{ type: 'permission_request', tool: 'Bash', toolUseId: 'tu_defer' }],
      pending
    );
    const permBroadcasts1 = batch1.filter(b => b.data.toolUseId === 'tu_defer');
    assert.equal(permBroadcasts1.length, 0, 'should not broadcast on first batch');
    assert.equal(pending.size, 1, 'should be deferred');

    // Batch 2: fallback poll — no new items
    const batch2 = processMainBatch([], pending);
    assert.equal(batch2.length, 1, 'should broadcast deferred permission');
    assert.equal(batch2[0].data.tool, 'Bash');
    assert.equal(batch2[0].data.toolUseId, 'tu_defer');
    assert.equal(pending.size, 0, 'should be cleared after broadcast');
  });

  it('cross-batch auto-resolved: deferred then silently removed by tool_result', () => {
    const pending = new Map();

    // Batch 1: permission arrives
    processMainBatch(
      [{ type: 'permission_request', tool: 'WebFetch', toolUseId: 'tu_cross' }],
      pending
    );
    assert.equal(pending.size, 1);

    // Batch 2: tool_result arrives — auto-approved between poll cycles
    const batch2 = processMainBatch(
      [{ type: 'tool_result', toolUseId: 'tu_cross', content: 'fetched' }],
      pending
    );
    // The deferred permission should be silently removed, not broadcast
    const permBroadcasts = batch2.filter(b => b.data.type === 'permission_request');
    assert.equal(permBroadcasts.length, 0, 'resolved permission should not broadcast');
    assert.equal(pending.size, 0, 'should be removed from pending');

    // The tool_result itself still passes through
    const results = batch2.filter(b => b.data.type === 'tool_result');
    assert.equal(results.length, 1);
  });

  it('mixed batch: one auto-approved in-batch, one deferred', () => {
    const pending = new Map();
    const items = [
      { type: 'permission_request', tool: 'Edit', toolUseId: 'tu_edit' },
      { type: 'permission_request', tool: 'Read', toolUseId: 'tu_read' },
      { type: 'tool_result', toolUseId: 'tu_read', content: 'auto-approved' }
    ];

    const batch1 = processMainBatch(items, pending);

    // Read was auto-approved in same batch → converted to type:tool
    const converted = batch1.find(b => b.data.toolUseId === 'tu_read' && b.data.type === 'tool');
    assert.ok(converted, 'Read should be converted to type:tool');

    // Edit has no tool_result → deferred
    assert.equal(pending.size, 1, 'Edit should be deferred');
    assert.ok(pending.has('tu_edit'));

    // Batch 2: Edit broadcasts
    const batch2 = processMainBatch([], pending);
    assert.equal(batch2.length, 1);
    assert.equal(batch2[0].data.tool, 'Edit');
    assert.equal(pending.size, 0);
  });

  it('permission_request without toolUseId falls through immediately', () => {
    const pending = new Map();
    const item = { type: 'permission_request', tool: 'Bash' };

    const broadcasts = processMainBatch([item], pending);
    assert.equal(pending.size, 0, 'should not be deferred without toolUseId');

    // Should broadcast immediately (falls through to filteredItems)
    const permBroadcasts = broadcasts.filter(b => b.data.type === 'permission_request');
    assert.equal(permBroadcasts.length, 1, 'should broadcast immediately');
    assert.equal(permBroadcasts[0].data.tool, 'Bash');
  });
});
