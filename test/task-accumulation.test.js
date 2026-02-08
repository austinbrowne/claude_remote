const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { parseTaskListResult } = require('../lib/parsers');

describe('parseTaskListResult', () => {
  it('parses standard TaskList output', () => {
    const text = `#1. [completed] Plan issues #10 + #11 (mic button + always-listening)
#2. [completed] Plan issue #12 (Always Allow permission bug)
#3. [in_progress] Implement server changes
#4. [pending] Write tests`;

    const tasks = parseTaskListResult(text);
    assert.equal(tasks.length, 4);
    assert.equal(tasks[0].id, '1');
    assert.equal(tasks[0].status, 'completed');
    assert.equal(tasks[0].subject, 'Plan issues #10 + #11 (mic button + always-listening)');
    assert.equal(tasks[2].status, 'in_progress');
    assert.equal(tasks[3].status, 'pending');
  });

  it('returns null for empty input', () => {
    assert.equal(parseTaskListResult(''), null);
    assert.equal(parseTaskListResult(null), null);
    assert.equal(parseTaskListResult(undefined), null);
  });

  it('returns null for non-task text', () => {
    assert.equal(parseTaskListResult('Some random output'), null);
    assert.equal(parseTaskListResult('Task created successfully'), null);
  });

  it('handles single task', () => {
    const tasks = parseTaskListResult('#1. [pending] Do something');
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, '1');
    assert.equal(tasks[0].subject, 'Do something');
  });

  it('handles multi-digit IDs', () => {
    const tasks = parseTaskListResult('#123. [completed] Big project task');
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, '123');
  });

  it('handles compound statuses like in_progress', () => {
    const tasks = parseTaskListResult('#5. [in_progress] Working on feature');
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].status, 'in_progress');
  });
});

describe('Task accumulation logic', () => {
  // Simulate sessionData.tasks Map
  function createSessionData() {
    return { tasks: new Map() };
  }

  it('accumulates task_create entries', () => {
    const sd = createSessionData();
    const task1 = { id: 'pending-1', subject: 'Task A', status: 'pending', description: 'Desc A', activeForm: null };
    const task2 = { id: 'pending-2', subject: 'Task B', status: 'pending', description: null, activeForm: 'Doing B' };

    sd.tasks.set(task1.id, task1);
    sd.tasks.set(task2.id, task2);

    assert.equal(sd.tasks.size, 2);
    assert.equal(sd.tasks.get('pending-1').subject, 'Task A');
  });

  it('updates existing task on task_update', () => {
    const sd = createSessionData();
    sd.tasks.set('pending-1', { id: 'pending-1', subject: 'Original', status: 'pending', description: null, activeForm: null });

    // Simulate task_update
    const existing = sd.tasks.get('pending-1');
    sd.tasks.set('pending-1', {
      ...existing,
      status: 'in_progress',
      activeForm: 'Working on it'
    });

    const updated = sd.tasks.get('pending-1');
    assert.equal(updated.status, 'in_progress');
    assert.equal(updated.activeForm, 'Working on it');
    assert.equal(updated.subject, 'Original'); // Preserved
  });

  it('removes task on deleted status', () => {
    const sd = createSessionData();
    sd.tasks.set('pending-1', { id: 'pending-1', subject: 'To delete', status: 'pending' });
    sd.tasks.set('pending-2', { id: 'pending-2', subject: 'To keep', status: 'pending' });

    // Simulate deleted status
    sd.tasks.delete('pending-1');

    assert.equal(sd.tasks.size, 1);
    assert.equal(sd.tasks.has('pending-1'), false);
    assert.equal(sd.tasks.has('pending-2'), true);
  });

  it('task_list replaces all tasks', () => {
    const sd = createSessionData();
    sd.tasks.set('old-1', { id: 'old-1', subject: 'Old task', status: 'pending' });

    // Simulate task_list authoritative snapshot
    sd.tasks.clear();
    const newTasks = [
      { id: '1', subject: 'New A', status: 'completed' },
      { id: '2', subject: 'New B', status: 'in_progress' }
    ];
    for (const t of newTasks) {
      sd.tasks.set(t.id, t);
    }

    assert.equal(sd.tasks.size, 2);
    assert.equal(sd.tasks.has('old-1'), false);
    assert.equal(sd.tasks.get('1').subject, 'New A');
  });

  it('buildClaudeState includes tasks array', () => {
    const sd = createSessionData();
    sd.tasks.set('1', { id: '1', subject: 'A', status: 'completed' });
    sd.tasks.set('2', { id: '2', subject: 'B', status: 'pending' });

    const tasksArray = Array.from(sd.tasks.values());
    assert.equal(tasksArray.length, 2);
    assert.equal(tasksArray[0].id, '1');
    assert.equal(tasksArray[1].id, '2');
  });
});

describe('CONS-005: pendingTaskListIds scoping', () => {
  // Simulate the tool_result handler logic from parseLogEntry
  function createSessionData() {
    return {
      tasks: new Map(),
      pendingTaskListIds: new Set()
    };
  }

  function simulateToolResult(sessionData, toolUseId, stdout) {
    const isTaskListResult = toolUseId && sessionData.pendingTaskListIds.has(toolUseId);
    if (isTaskListResult) {
      sessionData.pendingTaskListIds.delete(toolUseId);
      const taskListItems = parseTaskListResult(stdout);
      if (taskListItems && taskListItems.length > 0) {
        sessionData.tasks.clear();
        for (const task of taskListItems) {
          sessionData.tasks.set(task.id, {
            id: task.id,
            subject: task.subject,
            status: task.status
          });
        }
        return true; // tasks were updated
      }
    }
    return false; // tasks were NOT updated
  }

  it('parses task list when toolUseId is in pendingTaskListIds', () => {
    const sd = createSessionData();
    sd.tasks.set('existing', { id: 'existing', subject: 'Pre-existing', status: 'pending' });
    sd.pendingTaskListIds.add('toolu_tasklist1');

    const updated = simulateToolResult(sd, 'toolu_tasklist1', '#1. [completed] Done\n#2. [pending] Todo');
    assert.equal(updated, true);
    assert.equal(sd.tasks.size, 2);
    assert.equal(sd.tasks.has('existing'), false); // cleared
    assert.equal(sd.tasks.get('1').status, 'completed');
  });

  it('does NOT parse task list when toolUseId is not in pendingTaskListIds', () => {
    const sd = createSessionData();
    sd.tasks.set('existing', { id: 'existing', subject: 'Pre-existing', status: 'pending' });

    // Bash output that happens to match the task format
    const updated = simulateToolResult(sd, 'toolu_bash1', '#1. [completed] Done\n#2. [pending] Todo');
    assert.equal(updated, false);
    assert.equal(sd.tasks.size, 1); // unchanged
    assert.equal(sd.tasks.get('existing').subject, 'Pre-existing');
  });

  it('does NOT parse task list when toolUseId is null', () => {
    const sd = createSessionData();
    sd.tasks.set('existing', { id: 'existing', subject: 'Pre-existing', status: 'pending' });

    const updated = simulateToolResult(sd, null, '#1. [completed] Done');
    assert.equal(updated, false);
    assert.equal(sd.tasks.size, 1);
  });

  it('cleans up pendingTaskListIds after processing', () => {
    const sd = createSessionData();
    sd.pendingTaskListIds.add('toolu_tasklist1');

    simulateToolResult(sd, 'toolu_tasklist1', '#1. [pending] Task');
    assert.equal(sd.pendingTaskListIds.size, 0);
  });

  it('handles multiple TaskList calls independently', () => {
    const sd = createSessionData();
    sd.pendingTaskListIds.add('toolu_tl1');
    sd.pendingTaskListIds.add('toolu_tl2');

    simulateToolResult(sd, 'toolu_tl1', '#1. [pending] First call');
    assert.equal(sd.pendingTaskListIds.size, 1);
    assert.equal(sd.tasks.get('1').subject, 'First call');

    simulateToolResult(sd, 'toolu_tl2', '#1. [completed] Second call\n#2. [pending] New task');
    assert.equal(sd.pendingTaskListIds.size, 0);
    assert.equal(sd.tasks.size, 2);
    assert.equal(sd.tasks.get('1').subject, 'Second call');
  });
});
