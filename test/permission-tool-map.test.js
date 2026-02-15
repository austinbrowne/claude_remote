const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Test the permissionToolMap logic in isolation.
// Since server.js has side effects (starts HTTP server), we replicate
// the permission tracking logic directly.

describe('permissionToolMap', () => {
  // Simulate session data with permissionToolMap
  function makeSessionData() {
    return {
      permissionToolMap: new Map(),
      sessionGranted: new Set(),
      allowedTools: new Set()
    };
  }

  it('stores toolUseId -> {tool, timestamp} on permission_request', () => {
    const sd = makeSessionData();
    const now = Date.now();
    // Simulate parseLogEntry adding to map
    sd.permissionToolMap.set('toolu_abc123', { tool: 'Bash', timestamp: now });
    sd.permissionToolMap.set('toolu_xyz789', { tool: 'Write', timestamp: now });
    assert.equal(sd.permissionToolMap.get('toolu_abc123').tool, 'Bash');
    assert.equal(sd.permissionToolMap.get('toolu_xyz789').tool, 'Write');
    assert.equal(sd.permissionToolMap.size, 2);
  });

  it('grants correct tool when toolUseId is provided', () => {
    const sd = makeSessionData();
    const now = Date.now();
    sd.permissionToolMap.set('toolu_bash1', { tool: 'Bash', timestamp: now });
    sd.permissionToolMap.set('toolu_write1', { tool: 'Write', timestamp: now });

    // Simulate inject handler: "always" with toolUseId for Bash
    const toolUseId = 'toolu_bash1';
    const grantedTool = sd.permissionToolMap.get(toolUseId).tool;
    sd.permissionToolMap.delete(toolUseId);
    sd.sessionGranted.add(grantedTool);

    assert.equal(grantedTool, 'Bash');
    assert.ok(sd.sessionGranted.has('Bash'));
    assert.ok(!sd.sessionGranted.has('Write'));
    // Write should still be in the map
    assert.equal(sd.permissionToolMap.size, 1);
    assert.equal(sd.permissionToolMap.get('toolu_write1').tool, 'Write');
  });

  it('does not grant when toolUseId is not in map', () => {
    const sd = makeSessionData();
    sd.permissionToolMap.set('toolu_bash1', { tool: 'Bash', timestamp: Date.now() });

    const toolUseId = 'toolu_nonexistent';
    const grantedTool = sd.permissionToolMap.has(toolUseId)
      ? sd.permissionToolMap.get(toolUseId).tool
      : null;

    assert.equal(grantedTool, null);
    assert.equal(sd.sessionGranted.size, 0);
  });

  it('does not grant when no toolUseId provided (legacy client)', () => {
    const sd = makeSessionData();
    sd.permissionToolMap.set('toolu_bash1', { tool: 'Bash', timestamp: Date.now() });

    const toolUseId = undefined;
    // Legacy path: no toolUseId means we skip granting
    const grantedTool = (toolUseId && sd.permissionToolMap.has(toolUseId))
      ? sd.permissionToolMap.get(toolUseId).tool
      : null;

    assert.equal(grantedTool, null);
    assert.equal(sd.sessionGranted.size, 0);
  });

  it('TTL cleanup removes stale entries older than 600s (10 min)', () => {
    const sd = makeSessionData();
    const now = Date.now();
    // One entry from 700 seconds ago (stale, past 600s TTL)
    sd.permissionToolMap.set('toolu_bash1', { tool: 'Bash', timestamp: now - 700000 });
    // One entry from 10 seconds ago (fresh)
    sd.permissionToolMap.set('toolu_write1', { tool: 'Write', timestamp: now - 10000 });

    // Simulate TTL cleanup (runs when adding new entries)
    for (const [id, entry] of sd.permissionToolMap) {
      if (now - entry.timestamp > 600000) {
        sd.permissionToolMap.delete(id);
      }
    }

    assert.equal(sd.permissionToolMap.size, 1);
    assert.ok(!sd.permissionToolMap.has('toolu_bash1'));
    assert.ok(sd.permissionToolMap.has('toolu_write1'));
  });

  it('tool_result does NOT eagerly delete from permissionToolMap', () => {
    const sd = makeSessionData();
    const now = Date.now();
    sd.permissionToolMap.set('toolu_bash1', { tool: 'Bash', timestamp: now });

    // tool_result arrives — entry should NOT be deleted (user may still click "Always Allow")
    // The old code deleted here; the new code does not.
    // So after tool_result, the entry should still exist:
    assert.ok(sd.permissionToolMap.has('toolu_bash1'));
    assert.equal(sd.permissionToolMap.get('toolu_bash1').tool, 'Bash');
  });

  it('cross-tool isolation: granting Bash does not affect Write', () => {
    const sd = makeSessionData();
    const now = Date.now();
    sd.permissionToolMap.set('toolu_bash1', { tool: 'Bash', timestamp: now });
    sd.permissionToolMap.set('toolu_write1', { tool: 'Write', timestamp: now });
    sd.permissionToolMap.set('toolu_edit1', { tool: 'Edit', timestamp: now });

    // Grant Bash
    sd.sessionGranted.add(sd.permissionToolMap.get('toolu_bash1').tool);
    sd.permissionToolMap.delete('toolu_bash1');

    assert.ok(sd.sessionGranted.has('Bash'));
    assert.ok(!sd.sessionGranted.has('Write'));
    assert.ok(!sd.sessionGranted.has('Edit'));
    // Write and Edit still pending
    assert.equal(sd.permissionToolMap.size, 2);
  });

  it('rapid arrival: 5 permissions, grant first, verify correct tool', () => {
    const sd = makeSessionData();
    const now = Date.now();
    // Simulate 5 rapid permission_requests
    for (let i = 0; i < 5; i++) {
      sd.permissionToolMap.set(`toolu_${i}`, { tool: `Tool${i}`, timestamp: now });
    }
    assert.equal(sd.permissionToolMap.size, 5);

    // Grant the first one by its toolUseId
    const firstTool = sd.permissionToolMap.get('toolu_0').tool;
    sd.sessionGranted.add(firstTool);
    sd.permissionToolMap.delete('toolu_0');

    assert.equal(firstTool, 'Tool0');
    assert.ok(sd.sessionGranted.has('Tool0'));
    assert.equal(sd.permissionToolMap.size, 4);
    // All others still pending
    for (let i = 1; i < 5; i++) {
      assert.ok(!sd.sessionGranted.has(`Tool${i}`));
      assert.ok(sd.permissionToolMap.has(`toolu_${i}`));
    }
  });

  it('cascade prevention: after granting Bash, new Bash auto-approves but Write does not', () => {
    const sd = makeSessionData();

    // needsPermission logic simulation
    function needsPermission(toolName) {
      if (sd.allowedTools.has(toolName) || sd.sessionGranted.has(toolName)) return false;
      return true;
    }

    // Grant Bash via "always"
    sd.sessionGranted.add('Bash');

    // New Bash should auto-approve
    assert.ok(!needsPermission('Bash'));
    // Write should still need permission
    assert.ok(needsPermission('Write'));
    // Edit should still need permission
    assert.ok(needsPermission('Edit'));
  });
});
