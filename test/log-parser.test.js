'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createParserState, parseLogEntry } = require('../lib/log-parser');

// Minimal sessionData used across most tests.
function createSessionData() {
  return {
    milestones: [],
    toolBurstCount: 0,
    tasks: new Map(),
    permissionToolMap: new Map(),
    pendingTaskListIds: new Set(),
    allowedTools: new Set(),
    sessionGranted: new Set()
  };
}

// Helper: assert result is a single object (not null, not array)
function assertSingle(result) {
  assert.notEqual(result, null, 'expected a result, got null');
  assert.ok(!Array.isArray(result), `expected single object, got array: ${JSON.stringify(result)}`);
  return result;
}

// Helper: assert result is an array
function assertArray(result) {
  assert.ok(Array.isArray(result), `expected array, got: ${JSON.stringify(result)}`);
  return result;
}

// ─────────────────────────────────────────────
// 1. createParserState
// ─────────────────────────────────────────────
describe('createParserState', () => {
  it('returns an object with pendingSubagentDescriptions as a Map', () => {
    const state = createParserState();
    assert.ok(state.pendingSubagentDescriptions instanceof Map,
      'pendingSubagentDescriptions should be a Map');
  });

  it('returns an object with pendingTaskIds as a Map', () => {
    const state = createParserState();
    assert.ok(state.pendingTaskIds instanceof Map,
      'pendingTaskIds should be a Map');
  });

  it('returns an object with taskIdMap as a Map', () => {
    const state = createParserState();
    assert.ok(state.taskIdMap instanceof Map,
      'taskIdMap should be a Map');
  });

  it('returns fresh Maps (not shared between calls)', () => {
    const a = createParserState();
    const b = createParserState();
    a.pendingTaskIds.set('x', 'y');
    assert.equal(b.pendingTaskIds.size, 0);
  });
});

// ─────────────────────────────────────────────
// 2. parseLogEntry — progress entries
// ─────────────────────────────────────────────
describe('parseLogEntry — progress entries', () => {
  // parseLogEntry returns [{...}] (single-element array) for progress entries
  it('returns a status_update for progress type', () => {
    const state = createParserState();
    const sd = createSessionData();
    const entry = { type: 'progress', timestamp: '2026-01-01T00:00:00Z' };
    const results = assertArray(parseLogEntry(entry, sd, state));
    assert.equal(results[0].type, 'status_update');
  });

  it('progress status_update has a non-empty content string', () => {
    const state = createParserState();
    const sd = createSessionData();
    const entry = { type: 'progress' };
    const results = assertArray(parseLogEntry(entry, sd, state));
    assert.ok(typeof results[0].content === 'string' && results[0].content.length > 0,
      'content should be a non-empty string');
  });

  it('progress status_update preserves the entry timestamp', () => {
    const state = createParserState();
    const sd = createSessionData();
    const entry = { type: 'progress', timestamp: '2026-01-01T12:00:00Z' };
    const results = assertArray(parseLogEntry(entry, sd, state));
    assert.equal(results[0].timestamp, '2026-01-01T12:00:00Z');
  });
});

// ─────────────────────────────────────────────
// 3. parseLogEntry — system entries
// ─────────────────────────────────────────────
describe('parseLogEntry — system entries', () => {
  it('returns null for system type (skipped)', () => {
    const state = createParserState();
    const sd = createSessionData();
    const entry = { type: 'system', content: 'some system message' };
    assert.equal(parseLogEntry(entry, sd, state), null);
  });
});

// ─────────────────────────────────────────────
// 4. parseLogEntry — assistant text
// ─────────────────────────────────────────────
describe('parseLogEntry — assistant text', () => {
  it('returns type "assistant" for a text block', () => {
    const state = createParserState();
    const sd = createSessionData();
    const entry = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hello from Claude.' }] },
      timestamp: '2026-01-01T00:00:00Z'
    };
    const result = assertSingle(parseLogEntry(entry, sd, state));
    assert.equal(result.type, 'assistant');
    assert.equal(result.content, 'Hello from Claude.');
  });

  it('preserves the timestamp on assistant text result', () => {
    const state = createParserState();
    const sd = createSessionData();
    const entry = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Hi' }] },
      timestamp: '2026-01-01T09:00:00Z'
    };
    const result = assertSingle(parseLogEntry(entry, sd, state));
    assert.equal(result.timestamp, '2026-01-01T09:00:00Z');
  });

  it('handles assistant message where content is a plain string', () => {
    const state = createParserState();
    const sd = createSessionData();
    const entry = {
      type: 'assistant',
      message: { content: 'Plain string content' }
    };
    const result = assertSingle(parseLogEntry(entry, sd, state));
    assert.equal(result.type, 'assistant');
    assert.equal(result.content, 'Plain string content');
  });

  it('returns null for assistant entry with empty content array', () => {
    const state = createParserState();
    const sd = createSessionData();
    const entry = {
      type: 'assistant',
      message: { content: [] }
    };
    assert.equal(parseLogEntry(entry, sd, state), null);
  });
});

// ─────────────────────────────────────────────
// 5. parseLogEntry — assistant thinking blocks
// ─────────────────────────────────────────────
describe('parseLogEntry — assistant thinking blocks', () => {
  it('returns a status_update (not the thinking content) for thinking block', () => {
    const state = createParserState();
    const sd = createSessionData();
    const entry = {
      type: 'assistant',
      message: {
        content: [{ type: 'thinking', thinking: 'Internal monologue here...' }]
      }
    };
    const result = assertSingle(parseLogEntry(entry, sd, state));
    assert.equal(result.type, 'status_update');
    assert.notEqual(result.content, 'Internal monologue here...');
  });

  it('status_update from thinking block has a non-empty content string', () => {
    const state = createParserState();
    const sd = createSessionData();
    const entry = {
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: '...' }] }
    };
    const result = assertSingle(parseLogEntry(entry, sd, state));
    assert.ok(typeof result.content === 'string' && result.content.length > 0);
  });
});

// ─────────────────────────────────────────────
// 6. parseLogEntry — assistant tool_use (generic)
// ─────────────────────────────────────────────
describe('parseLogEntry — assistant tool_use (generic)', () => {
  it('returns type "tool" for an unrecognised tool name', () => {
    const state = createParserState();
    // Make sure the tool doesn't need permission by pre-allowing it
    const sd = createSessionData();
    sd.allowedTools.add('Read');
    const entry = {
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'tu_read_1',
          name: 'Read',
          input: { file_path: '/tmp/foo.txt' }
        }]
      }
    };
    // tool_use also emits a preceding status_update — expect array
    const results = assertArray(parseLogEntry(entry, sd, state));
    const toolResult = results.find(r => r.type === 'tool');
    assert.ok(toolResult, 'expected a tool result in array');
    assert.equal(toolResult.tool, 'Read');
  });

  it('includes toolUseId on the tool result', () => {
    const state = createParserState();
    const sd = createSessionData();
    sd.allowedTools.add('Glob');
    const entry = {
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'tu_glob_1',
          name: 'Glob',
          input: { pattern: '**/*.js' }
        }]
      }
    };
    const results = assertArray(parseLogEntry(entry, sd, state));
    const toolResult = results.find(r => r.type === 'tool');
    assert.equal(toolResult.toolUseId, 'tu_glob_1');
  });

  it('tool_use always emits a preceding status_update', () => {
    const state = createParserState();
    const sd = createSessionData();
    sd.allowedTools.add('Grep');
    const entry = {
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'tu_grep_1',
          name: 'Grep',
          input: {}
        }]
      }
    };
    const results = assertArray(parseLogEntry(entry, sd, state));
    assert.ok(results.some(r => r.type === 'status_update'), 'should include status_update');
  });
});

// ─────────────────────────────────────────────
// 7. parseLogEntry — assistant tool_use (permission required)
// ─────────────────────────────────────────────
describe('parseLogEntry — assistant tool_use (permission required)', () => {
  it('returns type "permission_request" when tool needs permission', () => {
    const state = createParserState();
    // allowedTools and sessionGranted are empty — Bash needs permission
    const sd = createSessionData();
    const entry = {
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'tu_bash_1',
          name: 'Bash',
          input: { command: 'ls -la' }
        }]
      }
    };
    const results = assertArray(parseLogEntry(entry, sd, state));
    const permResult = results.find(r => r.type === 'permission_request');
    assert.ok(permResult, 'expected permission_request in results');
    assert.equal(permResult.tool, 'Bash');
  });

  it('permission_request includes toolUseId', () => {
    const state = createParserState();
    const sd = createSessionData();
    const entry = {
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'tu_bash_2',
          name: 'Bash',
          input: { command: 'echo hi' }
        }]
      }
    };
    const results = assertArray(parseLogEntry(entry, sd, state));
    const permResult = results.find(r => r.type === 'permission_request');
    assert.equal(permResult.toolUseId, 'tu_bash_2');
  });

  it('does NOT emit permission_request when tool is pre-allowed', () => {
    const state = createParserState();
    const sd = createSessionData();
    sd.allowedTools.add('Bash');
    const entry = {
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'tu_bash_3',
          name: 'Bash',
          input: { command: 'pwd' }
        }]
      }
    };
    const results = assertArray(parseLogEntry(entry, sd, state));
    assert.ok(!results.some(r => r.type === 'permission_request'),
      'should not emit permission_request when pre-allowed');
  });

  it('does NOT emit permission_request when tool is session-granted', () => {
    const state = createParserState();
    const sd = createSessionData();
    sd.sessionGranted.add('Write');
    const entry = {
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'tu_write_1',
          name: 'Write',
          input: { file_path: '/tmp/test.txt', content: 'hello' }
        }]
      }
    };
    const results = assertArray(parseLogEntry(entry, sd, state));
    assert.ok(!results.some(r => r.type === 'permission_request'));
  });

  it('adds tool to permissionToolMap when permission is required', () => {
    const state = createParserState();
    const sd = createSessionData();
    const entry = {
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'tu_edit_1',
          name: 'Edit',
          input: {}
        }]
      }
    };
    parseLogEntry(entry, sd, state);
    assert.ok(sd.permissionToolMap.has('tu_edit_1'), 'should add entry to permissionToolMap');
    assert.equal(sd.permissionToolMap.get('tu_edit_1').tool, 'Edit');
  });
});

// ─────────────────────────────────────────────
// 8. parseLogEntry — assistant tool_use (TaskCreate)
// ─────────────────────────────────────────────
// TaskCreate is an internal tool that must be pre-allowed. The permission gate in
// handleToolUseBlock runs first (else-if chain), so TaskCreate only reaches its own
// branch when needsPermission returns false (i.e. the tool is in allowedTools).
describe('parseLogEntry — assistant tool_use (TaskCreate)', () => {
  it('returns task_create with subject and a pending ID', () => {
    const state = createParserState();
    const sd = createSessionData();
    sd.allowedTools.add('TaskCreate');
    const entry = {
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'tu_tc_1',
          name: 'TaskCreate',
          input: {
            subject: 'Fix the login bug',
            description: 'The login flow is broken.',
            activeForm: 'Fixing the login bug'
          }
        }]
      }
    };
    const results = assertArray(parseLogEntry(entry, sd, state));
    const tc = results.find(r => r.type === 'task_create');
    assert.ok(tc, 'expected task_create result');
    assert.equal(tc.subject, 'Fix the login bug');
    assert.ok(tc.id && tc.id.startsWith('pending-'), 'id should start with "pending-"');
  });

  it('adds the pending task to sessionData.tasks', () => {
    const state = createParserState();
    const sd = createSessionData();
    sd.allowedTools.add('TaskCreate');
    const entry = {
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'tu_tc_2',
          name: 'TaskCreate',
          input: { subject: 'Add tests' }
        }]
      }
    };
    parseLogEntry(entry, sd, state);
    assert.equal(sd.tasks.size, 1);
    const [task] = sd.tasks.values();
    assert.equal(task.subject, 'Add tests');
    assert.equal(task.status, 'pending');
  });

  it('stores tool_use_id -> pendingId in parserState.pendingTaskIds', () => {
    const state = createParserState();
    const sd = createSessionData();
    sd.allowedTools.add('TaskCreate');
    const entry = {
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'tu_tc_3',
          name: 'TaskCreate',
          input: { subject: 'Deploy' }
        }]
      }
    };
    parseLogEntry(entry, sd, state);
    assert.ok(state.pendingTaskIds.has('tu_tc_3'), 'pendingTaskIds should contain tool_use_id');
  });
});

// ─────────────────────────────────────────────
// 9. parseLogEntry — assistant tool_use (Task / subagent)
// ─────────────────────────────────────────────
// Task is an internal tool; it must be pre-allowed so it bypasses the permission gate.
describe('parseLogEntry — assistant tool_use (Task/subagent)', () => {
  it('returns subagent_starting for Task tool', () => {
    const state = createParserState();
    const sd = createSessionData();
    sd.allowedTools.add('Task');
    const entry = {
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'tu_task_1',
          name: 'Task',
          input: {
            description: 'Investigate the crash report',
            subagent_type: 'explorer'
          }
        }]
      }
    };
    const results = assertArray(parseLogEntry(entry, sd, state));
    const subagent = results.find(r => r.type === 'subagent_starting');
    assert.ok(subagent, 'expected subagent_starting in results');
    assert.equal(subagent.content, 'Investigate the crash report');
    assert.equal(subagent.agentType, 'explorer');
  });

  it('subagent_starting stores description in pendingSubagentDescriptions', () => {
    const state = createParserState();
    const sd = createSessionData();
    sd.allowedTools.add('Task');
    const entry = {
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'tu_task_2',
          name: 'Task',
          input: { description: 'Run the tests', subagent_type: 'tester' }
        }]
      }
    };
    parseLogEntry(entry, sd, state);
    assert.equal(state.pendingSubagentDescriptions.size, 1);
    const [entry_] = state.pendingSubagentDescriptions.values();
    assert.equal(entry_.description, 'Run the tests');
    assert.equal(entry_.type, 'tester');
  });
});

// ─────────────────────────────────────────────
// 10. parseLogEntry — assistant tool_use (EnterPlanMode)
// ─────────────────────────────────────────────
// EnterPlanMode is an internal tool; it must be pre-allowed so it bypasses the permission gate.
describe('parseLogEntry — assistant tool_use (EnterPlanMode)', () => {
  it('returns mode_change with mode "plan"', () => {
    const state = createParserState();
    const sd = createSessionData();
    sd.allowedTools.add('EnterPlanMode');
    const entry = {
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'tu_epm_1',
          name: 'EnterPlanMode',
          input: {}
        }]
      }
    };
    const results = assertArray(parseLogEntry(entry, sd, state));
    const modeChange = results.find(r => r.type === 'mode_change');
    assert.ok(modeChange, 'expected mode_change');
    assert.equal(modeChange.mode, 'plan');
  });
});

// ─────────────────────────────────────────────
// 11. parseLogEntry — assistant tool_use (ExitPlanMode)
// ─────────────────────────────────────────────
// ExitPlanMode is an internal tool; it must be pre-allowed so it bypasses the permission gate.
describe('parseLogEntry — assistant tool_use (ExitPlanMode)', () => {
  it('returns both mode_change and exit_plan_mode', () => {
    const state = createParserState();
    const sd = createSessionData();
    sd.allowedTools.add('ExitPlanMode');
    const entry = {
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'tu_xpm_1',
          name: 'ExitPlanMode',
          input: {}
        }]
      }
    };
    const results = assertArray(parseLogEntry(entry, sd, state));
    const modeChange = results.find(r => r.type === 'mode_change');
    const exitPlan = results.find(r => r.type === 'exit_plan_mode');
    assert.ok(modeChange, 'expected mode_change');
    assert.equal(modeChange.mode, 'default');
    assert.ok(exitPlan, 'expected exit_plan_mode');
  });
});

// ─────────────────────────────────────────────
// 12. parseLogEntry — user message (human input)
// ─────────────────────────────────────────────
describe('parseLogEntry — user message (human input)', () => {
  it('returns type "user" with content for plain string message', () => {
    const state = createParserState();
    const sd = createSessionData();
    const entry = {
      type: 'user',
      message: { content: 'Please fix the bug.' },
      timestamp: '2026-01-01T08:00:00Z'
    };
    const result = assertSingle(parseLogEntry(entry, sd, state));
    assert.equal(result.type, 'user');
    assert.equal(result.content, 'Please fix the bug.');
  });

  it('returns type "user" for text block inside array content', () => {
    const state = createParserState();
    const sd = createSessionData();
    const entry = {
      type: 'user',
      message: {
        content: [{ type: 'text', text: 'Check the logs.' }]
      }
    };
    const result = assertSingle(parseLogEntry(entry, sd, state));
    assert.equal(result.type, 'user');
    assert.equal(result.content, 'Check the logs.');
  });

  it('returns null for command invocation messages (command-message tag)', () => {
    const state = createParserState();
    const sd = createSessionData();
    const entry = {
      type: 'user',
      message: { content: '<command-message>/compact</command-message>' }
    };
    assert.equal(parseLogEntry(entry, sd, state), null);
  });

  it('returns null for command-name tag messages', () => {
    const state = createParserState();
    const sd = createSessionData();
    const entry = {
      type: 'user',
      message: { content: '<command-name>plan</command-name>' }
    };
    assert.equal(parseLogEntry(entry, sd, state), null);
  });
});

// ─────────────────────────────────────────────
// 13. parseLogEntry — user message (tool result)
// ─────────────────────────────────────────────
describe('parseLogEntry — user message (tool result)', () => {
  it('returns type "tool_result" when entry has toolUseResult', () => {
    const state = createParserState();
    const sd = createSessionData();
    const entry = {
      type: 'user',
      toolUseResult: { stdout: 'file contents here', stderr: '' },
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tu_read_1' }]
      },
      timestamp: '2026-01-01T00:00:00Z'
    };
    const result = assertSingle(parseLogEntry(entry, sd, state));
    assert.equal(result.type, 'tool_result');
    assert.equal(result.content, 'file contents here');
  });

  it('tool_result content is "(completed)" when stdout and stderr are empty', () => {
    const state = createParserState();
    const sd = createSessionData();
    const entry = {
      type: 'user',
      toolUseResult: { stdout: '', stderr: '' },
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tu_bash_ok' }]
      }
    };
    const result = assertSingle(parseLogEntry(entry, sd, state));
    assert.equal(result.type, 'tool_result');
    assert.equal(result.content, '(completed)');
  });

  it('isError is true when only stderr is present', () => {
    const state = createParserState();
    const sd = createSessionData();
    const entry = {
      type: 'user',
      toolUseResult: { stdout: '', stderr: 'Error: file not found' },
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tu_fail_1' }]
      }
    };
    const result = assertSingle(parseLogEntry(entry, sd, state));
    assert.equal(result.isError, true);
  });

  it('isError is false when stdout is present', () => {
    const state = createParserState();
    const sd = createSessionData();
    const entry = {
      type: 'user',
      toolUseResult: { stdout: 'ok', stderr: '' },
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tu_ok_1' }]
      }
    };
    const result = assertSingle(parseLogEntry(entry, sd, state));
    assert.equal(result.isError, false);
  });

  it('returns null for subagent tool result (has agentId)', () => {
    const state = createParserState();
    const sd = createSessionData();
    const entry = {
      type: 'user',
      toolUseResult: { stdout: 'done', agentId: 'agent-abc-123' }
    };
    assert.equal(parseLogEntry(entry, sd, state), null);
  });
});

// ─────────────────────────────────────────────
// 14. parseLogEntry — user message (isMeta)
// ─────────────────────────────────────────────
describe('parseLogEntry — user message (isMeta)', () => {
  it('returns null for isMeta entries', () => {
    const state = createParserState();
    const sd = createSessionData();
    const entry = {
      type: 'user',
      isMeta: true,
      message: { content: 'Skill definition injected by CLI' }
    };
    assert.equal(parseLogEntry(entry, sd, state), null);
  });
});

// ─────────────────────────────────────────────
// 15. ParserState correlation — TaskCreate + tool_result
// ─────────────────────────────────────────────
describe('parseLogEntry — parserState correlation (TaskCreate -> tool_result)', () => {
  it('maps real task ID to pending ID via tool_result', () => {
    const state = createParserState();
    const sd = createSessionData();
    // TaskCreate must be pre-allowed; see comment on TaskCreate test suite above
    sd.allowedTools.add('TaskCreate');

    // Step 1: TaskCreate emits a pending ID and stores it in pendingTaskIds
    const createEntry = {
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'tu_tc_corr_1',
          name: 'TaskCreate',
          input: { subject: 'Write docs' }
        }]
      }
    };
    const createResults = assertArray(parseLogEntry(createEntry, sd, state));
    const tc = createResults.find(r => r.type === 'task_create');
    const pendingId = tc.id;
    assert.ok(pendingId.startsWith('pending-'));
    assert.ok(state.pendingTaskIds.has('tu_tc_corr_1'));

    // Step 2: tool_result arrives with the real ID in stdout
    const resultEntry = {
      type: 'user',
      toolUseResult: { stdout: 'Created task #42: Write docs', stderr: '' },
      message: {
        content: [{ type: 'tool_result', tool_use_id: 'tu_tc_corr_1' }]
      }
    };
    parseLogEntry(resultEntry, sd, state);

    // The correlation should now be in taskIdMap
    assert.ok(state.taskIdMap.has('42'), 'taskIdMap should map real ID "42" to pending ID');
    assert.equal(state.taskIdMap.get('42'), pendingId);

    // pendingTaskIds entry should be cleaned up after correlation
    assert.ok(!state.pendingTaskIds.has('tu_tc_corr_1'), 'pendingTaskIds should be cleaned up');
  });
});

// ─────────────────────────────────────────────
// 16. Multiple results — text + tool_use in same message
// ─────────────────────────────────────────────
describe('parseLogEntry — multiple results (text + tool_use)', () => {
  it('returns an array when assistant message has both text and tool_use', () => {
    const state = createParserState();
    const sd = createSessionData();
    sd.allowedTools.add('Read');

    const entry = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Let me check that file.' },
          { type: 'tool_use', id: 'tu_read_multi', name: 'Read', input: { file_path: '/tmp/x' } }
        ]
      }
    };
    const results = assertArray(parseLogEntry(entry, sd, state));
    assert.ok(results.length >= 2, 'should have at least 2 results');
    assert.ok(results.some(r => r.type === 'assistant'), 'should include assistant result');
    // tool_use emits status_update + tool
    assert.ok(results.some(r => r.type === 'tool'), 'should include tool result');
  });

  it('assistant text comes before tool results in the array', () => {
    const state = createParserState();
    const sd = createSessionData();
    sd.allowedTools.add('Glob');

    const entry = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Searching now.' },
          { type: 'tool_use', id: 'tu_glob_m', name: 'Glob', input: { pattern: '**' } }
        ]
      }
    };
    const results = assertArray(parseLogEntry(entry, sd, state));
    const assistantIdx = results.findIndex(r => r.type === 'assistant');
    const toolIdx = results.findIndex(r => r.type === 'tool');
    assert.ok(assistantIdx < toolIdx, 'assistant result should precede tool result');
  });
});
