const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { MAX_MILESTONES, detectMilestone, extractMilestones } = require('../lib/log-parser');

function createSessionData() {
  return { milestones: [], toolBurstCount: 0 };
}

describe('detectMilestone', () => {
  it('returns null for tool items (increments burst count)', () => {
    const sd = createSessionData();
    const result = detectMilestone({ type: 'tool', tool: 'Read' }, sd);
    assert.equal(result, null);
    assert.equal(sd.toolBurstCount, 1);
  });

  it('increments burst for permission_request items', () => {
    const sd = createSessionData();
    detectMilestone({ type: 'permission_request', tool: 'Bash' }, sd);
    assert.equal(sd.toolBurstCount, 1);
  });

  it('increments burst for status_update with tool field', () => {
    const sd = createSessionData();
    detectMilestone({ type: 'status_update', tool: 'Grep', content: 'Searching...' }, sd);
    assert.equal(sd.toolBurstCount, 1);
  });

  it('does NOT increment burst for status_update without tool field', () => {
    const sd = createSessionData();
    detectMilestone({ type: 'status_update', content: 'Thinking...' }, sd);
    assert.equal(sd.toolBurstCount, 0);
  });

  it('detects milestone when assistant follows 2+ tools', () => {
    const sd = createSessionData();
    detectMilestone({ type: 'tool', tool: 'Read' }, sd);
    detectMilestone({ type: 'tool', tool: 'Edit' }, sd);
    const result = detectMilestone({
      type: 'assistant',
      content: 'I updated the file.',
      timestamp: '2026-01-01T00:00:00Z'
    }, sd);
    assert.notEqual(result, null);
    assert.equal(result.text, 'I updated the file.');
    assert.equal(result.toolCount, 2);
    assert.equal(result.timestamp, '2026-01-01T00:00:00Z');
  });

  it('does NOT detect milestone when assistant follows only 1 tool', () => {
    const sd = createSessionData();
    detectMilestone({ type: 'tool', tool: 'Read' }, sd);
    const result = detectMilestone({
      type: 'assistant',
      content: 'Here is the file.'
    }, sd);
    assert.equal(result, null);
    assert.equal(sd.toolBurstCount, 0); // reset
  });

  it('does NOT detect milestone when assistant follows 0 tools', () => {
    const sd = createSessionData();
    const result = detectMilestone({
      type: 'assistant',
      content: 'Hello!'
    }, sd);
    assert.equal(result, null);
  });

  it('resets burst count on user message', () => {
    const sd = createSessionData();
    detectMilestone({ type: 'tool', tool: 'Read' }, sd);
    detectMilestone({ type: 'tool', tool: 'Grep' }, sd);
    assert.equal(sd.toolBurstCount, 2);
    detectMilestone({ type: 'user', content: 'Do something' }, sd);
    assert.equal(sd.toolBurstCount, 0);
  });

  it('resets burst count after milestone detection', () => {
    const sd = createSessionData();
    detectMilestone({ type: 'tool', tool: 'Read' }, sd);
    detectMilestone({ type: 'tool', tool: 'Edit' }, sd);
    detectMilestone({ type: 'tool', tool: 'Bash' }, sd);
    detectMilestone({ type: 'assistant', content: 'Done.', timestamp: 'T1' }, sd);
    assert.equal(sd.toolBurstCount, 0);
    // Next assistant without tools should NOT be a milestone
    const result = detectMilestone({ type: 'assistant', content: 'Anything else?' }, sd);
    assert.equal(result, null);
  });

  it('adds milestone to sessionData.milestones array', () => {
    const sd = createSessionData();
    detectMilestone({ type: 'tool', tool: 'Read' }, sd);
    detectMilestone({ type: 'tool', tool: 'Edit' }, sd);
    detectMilestone({ type: 'assistant', content: 'Updated.', timestamp: 'T1' }, sd);
    assert.equal(sd.milestones.length, 1);
    assert.equal(sd.milestones[0].text, 'Updated.');
  });

  it('evicts oldest milestone when over MAX_MILESTONES', () => {
    const sd = createSessionData();
    // Create 21 milestones
    for (let i = 0; i < 21; i++) {
      detectMilestone({ type: 'tool', tool: 'A' }, sd);
      detectMilestone({ type: 'tool', tool: 'B' }, sd);
      detectMilestone({ type: 'assistant', content: `Milestone ${i}`, timestamp: `T${i}` }, sd);
    }
    assert.equal(sd.milestones.length, MAX_MILESTONES);
    // First milestone should be #1 (0 was evicted)
    assert.equal(sd.milestones[0].text, 'Milestone 1');
    assert.equal(sd.milestones[sd.milestones.length - 1].text, 'Milestone 20');
  });

  it('returns null for null sessionData', () => {
    const result = detectMilestone({ type: 'tool', tool: 'Read' }, null);
    assert.equal(result, null);
  });

  it('handles mixed tool types in a burst', () => {
    const sd = createSessionData();
    detectMilestone({ type: 'tool', tool: 'Read' }, sd);
    detectMilestone({ type: 'permission_request', tool: 'Bash' }, sd);
    detectMilestone({ type: 'status_update', tool: 'Grep', content: '...' }, sd);
    const result = detectMilestone({
      type: 'assistant',
      content: 'All done.',
      timestamp: 'T1'
    }, sd);
    assert.notEqual(result, null);
    assert.equal(result.toolCount, 3);
  });
});

describe('extractMilestones', () => {
  it('extracts milestones from a sequence of items', () => {
    const sd = createSessionData();
    const items = [
      { type: 'assistant', content: 'Starting...', timestamp: 'T0' },
      { type: 'tool', tool: 'Read', timestamp: 'T1' },
      { type: 'tool', tool: 'Grep', timestamp: 'T2' },
      { type: 'tool', tool: 'Edit', timestamp: 'T3' },
      { type: 'assistant', content: 'I found and fixed the bug.', timestamp: 'T4' },
      { type: 'tool', tool: 'Bash', timestamp: 'T5' },
      { type: 'assistant', content: 'Tests pass.', timestamp: 'T6' }
    ];
    const milestones = extractMilestones(items, sd);
    // Only the first assistant after 3 tools is a milestone
    // The second assistant follows only 1 tool — not a milestone
    assert.equal(milestones.length, 1);
    assert.equal(milestones[0].text, 'I found and fixed the bug.');
    assert.equal(milestones[0].toolCount, 3);
  });

  it('detects multiple milestones in a sequence', () => {
    const sd = createSessionData();
    const items = [
      { type: 'tool', tool: 'Read', timestamp: 'T1' },
      { type: 'tool', tool: 'Edit', timestamp: 'T2' },
      { type: 'assistant', content: 'First update.', timestamp: 'T3' },
      { type: 'tool', tool: 'Grep', timestamp: 'T4' },
      { type: 'tool', tool: 'Read', timestamp: 'T5' },
      { type: 'tool', tool: 'Edit', timestamp: 'T6' },
      { type: 'assistant', content: 'Second update.', timestamp: 'T7' }
    ];
    const milestones = extractMilestones(items, sd);
    assert.equal(milestones.length, 2);
    assert.equal(milestones[0].text, 'First update.');
    assert.equal(milestones[0].toolCount, 2);
    assert.equal(milestones[1].text, 'Second update.');
    assert.equal(milestones[1].toolCount, 3);
  });

  it('returns empty array when no milestones found', () => {
    const sd = createSessionData();
    const items = [
      { type: 'assistant', content: 'Hello' },
      { type: 'tool', tool: 'Read' },
      { type: 'assistant', content: 'Here you go.' }
    ];
    const milestones = extractMilestones(items, sd);
    assert.equal(milestones.length, 0);
  });

  it('handles empty items array', () => {
    const sd = createSessionData();
    const milestones = extractMilestones([], sd);
    assert.equal(milestones.length, 0);
  });

  it('user message breaks a tool burst', () => {
    const sd = createSessionData();
    const items = [
      { type: 'tool', tool: 'Read' },
      { type: 'tool', tool: 'Grep' },
      { type: 'user', content: 'Stop' },
      { type: 'assistant', content: 'Okay, stopping.' }
    ];
    const milestones = extractMilestones(items, sd);
    assert.equal(milestones.length, 0);
  });
});
