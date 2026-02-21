const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Replicate compaction-related parsing logic from parseLogEntry in server.js
// (server.js can't be imported directly due to side effects)

// Simulates the local-command-stdout handling in parseLogEntry's user entry path
function parseLocalCommandStdout(content, timestamp) {
  if (typeof content !== 'string') return null;
  if (!content.includes('<local-command-stdout>')) return null;

  // Detect compaction completion
  if (content.includes('Compacted')) {
    return [{ type: 'compaction_complete', content: 'Context compacted', timestamp: timestamp || new Date().toISOString() }];
  }

  // Other local command output — skip
  return null;
}

// Simulates the isCompactSummary detection in handleUserEntry
function parseCompactSummary(entry, timestamp) {
  if (entry.isCompactSummary) {
    return [{ type: 'compaction_complete', content: 'Context compacted', timestamp: timestamp || new Date().toISOString() }];
  }
  return null;
}

function isCommandWrapper(content) {
  if (typeof content !== 'string') return false;
  return content.includes('<command-message>') || content.includes('<command-name>');
}

describe('Compaction handling', () => {

  describe('parseLocalCommandStdout — detects compaction from local-command-stdout', () => {
    it('emits compaction_complete when stdout contains Compacted', () => {
      const content = '<local-command-stdout>\x1b[2mCompacted (ctrl+o to see full summary)\x1b[22m</local-command-stdout>';
      const result = parseLocalCommandStdout(content, '2026-02-17T10:00:00Z');
      assert.deepStrictEqual(result, [{
        type: 'compaction_complete',
        content: 'Context compacted',
        timestamp: '2026-02-17T10:00:00Z'
      }]);
    });

    it('returns null for non-compaction local command output', () => {
      const content = '<local-command-stdout>Goodbye!</local-command-stdout>';
      const result = parseLocalCommandStdout(content);
      assert.strictEqual(result, null);
    });

    it('returns null for non-string input', () => {
      assert.strictEqual(parseLocalCommandStdout(null), null);
      assert.strictEqual(parseLocalCommandStdout(undefined), null);
      assert.strictEqual(parseLocalCommandStdout(42), null);
    });

    it('returns null for content without local-command-stdout tag', () => {
      assert.strictEqual(parseLocalCommandStdout('Hello world'), null);
      assert.strictEqual(parseLocalCommandStdout('Compacted'), null);
    });

    it('uses fallback timestamp when none provided', () => {
      const content = '<local-command-stdout>Compacted</local-command-stdout>';
      const result = parseLocalCommandStdout(content);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].type, 'compaction_complete');
      assert.ok(result[0].timestamp);
    });
  });

  describe('parseCompactSummary — detects auto-compaction from isCompactSummary field', () => {
    it('emits compaction_complete for entry with isCompactSummary: true', () => {
      const entry = {
        type: 'user',
        isCompactSummary: true,
        message: {
          role: 'user',
          content: 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nAnalysis:\nLong summary text...'
        }
      };
      const result = parseCompactSummary(entry, '2026-02-19T10:00:00Z');
      assert.deepStrictEqual(result, [{
        type: 'compaction_complete',
        content: 'Context compacted',
        timestamp: '2026-02-19T10:00:00Z'
      }]);
    });

    it('returns null for regular user entry without isCompactSummary', () => {
      const entry = {
        type: 'user',
        message: { role: 'user', content: 'Hello' }
      };
      assert.strictEqual(parseCompactSummary(entry, '2026-02-19T10:00:00Z'), null);
    });

    it('returns null when isCompactSummary is false', () => {
      const entry = {
        type: 'user',
        isCompactSummary: false,
        message: { role: 'user', content: 'Not a summary' }
      };
      assert.strictEqual(parseCompactSummary(entry, '2026-02-19T10:00:00Z'), null);
    });
  });

  describe('isCommandWrapper — filters command invocations', () => {
    it('detects <command-name> tag', () => {
      assert.strictEqual(isCommandWrapper('<command-name>/compact</command-name>'), true);
    });

    it('detects <command-message> tag', () => {
      assert.strictEqual(isCommandWrapper('<command-message>compact</command-message>'), true);
    });

    it('does not match local-command-stdout (handled separately)', () => {
      assert.strictEqual(isCommandWrapper('<local-command-stdout>Compacted</local-command-stdout>'), false);
    });

    it('does not match normal user text', () => {
      assert.strictEqual(isCommandWrapper('Hello, how are you?'), false);
    });

    it('handles non-string input', () => {
      assert.strictEqual(isCommandWrapper(null), false);
      assert.strictEqual(isCommandWrapper(undefined), false);
      assert.strictEqual(isCommandWrapper(42), false);
    });
  });
});
