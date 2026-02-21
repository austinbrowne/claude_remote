const { parseTaskListResult } = require('./parsers');
const { getRandomSpinnerVerb, stripAnsi, formatMcpToolName, sanitizeMcpInput } = require('./utils');
const { needsPermission } = require('./session-discovery');

const MAX_MILESTONES = 20;

/**
 * Create the shared parser state that persists across log entries.
 * Passed into parseLogEntry so it can track cross-entry correlations.
 */
function createParserState() {
  return {
    pendingSubagentDescriptions: new Map(), // timestamp -> { description, type }
    pendingTaskIds: new Map(),  // tool_use_id → pendingId
    taskIdMap: new Map()        // realId → pendingId
  };
}

/**
 * Process a single parsed item for milestone detection.
 * Mutates sessionData.toolBurstCount and sessionData.milestones.
 * Returns a milestone object if one was detected, null otherwise.
 */
function detectMilestone(item, sessionData) {
  if (!sessionData) return null;

  // Tool-like items increment the burst counter
  if (item.type === 'tool' || item.type === 'permission_request' ||
      (item.type === 'status_update' && item.tool)) {
    sessionData.toolBurstCount++;
    return null;
  }

  // Assistant text after 2+ tool calls = milestone
  if (item.type === 'assistant' && sessionData.toolBurstCount >= 2) {
    const milestone = {
      text: item.content || '',
      timestamp: item.timestamp || new Date().toISOString(),
      toolCount: sessionData.toolBurstCount
    };
    sessionData.milestones.push(milestone);
    // Evict oldest if over capacity
    while (sessionData.milestones.length > MAX_MILESTONES) {
      sessionData.milestones.shift();
    }
    sessionData.toolBurstCount = 0;
    return milestone;
  }

  // Assistant with < 2 tools, or user message — reset burst
  if (item.type === 'assistant' || item.type === 'user') {
    sessionData.toolBurstCount = 0;
  }

  return null;
}

/**
 * Scan an array of parsed items and extract all milestones.
 * Returns an array of milestone objects. Mutates sessionData.toolBurstCount.
 */
function extractMilestones(items, sessionData) {
  const milestones = [];
  for (const item of items) {
    const m = detectMilestone(item, sessionData);
    if (m) milestones.push(m);
  }
  return milestones;
}

/**
 * Handle a tool_use block from an assistant message.
 * Returns an array of result items to append to the caller's results.
 */
function handleToolUseBlock(block, sessionData, parserState, timestamp) {
  const { pendingSubagentDescriptions, pendingTaskIds, taskIdMap } = parserState;
  const results = [];

  // Emit status update with random spinner verb (like terminal)
  results.push({
    type: 'status_update',
    content: `${getRandomSpinnerVerb()}...`,
    tool: block.name,
    timestamp
  });

  const isMcpTool = block.name && block.name.startsWith('mcp__');

  // Special handling for AskUserQuestion - emit as structured prompt
  if (block.name === 'AskUserQuestion' && block.input?.questions) {
    results.push({
      type: 'ask_user_question',
      questions: block.input.questions,
      timestamp
    });
  }
  // Permission-requiring tools - only emit if not pre-allowed
  else if (needsPermission(block.name, sessionData) || (isMcpTool && needsPermission(block.name, sessionData))) {
    console.log(`[Permission] Detected ${block.name} tool call`);
    if (sessionData && block.id) {
      // Clean stale entries (>600s / 10 min) before adding new one
      const now = Date.now();
      for (const [id, entry] of sessionData.permissionToolMap) {
        if (now - entry.timestamp > 600000) {
          sessionData.permissionToolMap.delete(id);
        }
      }
      sessionData.permissionToolMap.set(block.id, { tool: block.name, timestamp: now });
    }
    results.push({
      type: 'permission_request',
      tool: isMcpTool ? formatMcpToolName(block.name) : block.name,
      input: isMcpTool ? sanitizeMcpInput(block.input) : (block.input || {}),
      toolUseId: block.id || null,
      timestamp
    });
  }
  // Task management tools - emit for task tracking
  else if (block.name === 'TaskCreate') {
    const pendingId = 'pending-' + Date.now();
    if (block.id) {
      pendingTaskIds.set(block.id, pendingId);
    }
    const taskData = {
      id: pendingId,
      subject: block.input?.subject,
      description: block.input?.description,
      activeForm: block.input?.activeForm,
      status: 'pending'
    };
    if (sessionData) {
      sessionData.tasks.set(pendingId, taskData);
    }
    results.push({ type: 'task_create', ...taskData });
  }
  else if (block.name === 'TaskUpdate') {
    const realId = String(block.input?.taskId ?? '');
    const mappedId = taskIdMap.get(realId) || realId;
    const newStatus = block.input?.status;
    if (sessionData) {
      if (newStatus === 'deleted') {
        sessionData.tasks.delete(mappedId);
      } else {
        const existing = sessionData.tasks.get(mappedId) || { id: mappedId };
        sessionData.tasks.set(mappedId, {
          ...existing,
          status: newStatus ?? existing.status,
          subject: block.input?.subject ?? existing.subject,
          description: block.input?.description ?? existing.description,
          activeForm: block.input?.activeForm ?? existing.activeForm
        });
      }
    }
    results.push({
      type: 'task_update',
      taskId: mappedId,
      status: newStatus,
      subject: block.input?.subject,
      description: block.input?.description,
      activeForm: block.input?.activeForm
    });
  }
  else if (block.name === 'TaskList') {
    // Track this tool_use ID so we only run parseTaskListResult on actual TaskList results
    if (sessionData && block.id) {
      sessionData.pendingTaskListIds.add(block.id);
    }
  }
  else if (block.name === 'EnterPlanMode') {
    results.push({ type: 'mode_change', mode: 'plan', timestamp });
  }
  else if (block.name === 'ExitPlanMode') {
    results.push({ type: 'mode_change', mode: 'default', timestamp });
    // Also emit exit_plan_mode for interactive prompt (separate from mode_change state tracking)
    results.push({ type: 'exit_plan_mode', timestamp });
  }
  else if (block.name === 'Task') {
    // Subagent being spawned - track description for correlation
    const agentDescription = block.input?.description || 'Subagent';
    const agentType = block.input?.subagent_type || 'general';
    const teamName = block.input?.team_name || null;
    const memberName = block.input?.name || null;
    pendingSubagentDescriptions.set(Date.now(), {
      description: agentDescription,
      type: agentType,
      teamName,
      memberName
    });
    results.push({
      type: 'subagent_starting',
      content: agentDescription,
      tool: agentType,
      description: agentDescription,
      agentType: agentType,
      teamName,
      memberName,
      timestamp
    });
  }
  else if (block.name === 'TeamCreate') {
    const teamName = block.input?.team_name || 'unnamed-team';
    results.push({
      type: 'team_create',
      teamName,
      timestamp
    });
  }
  else if (block.name === 'TeamDelete') {
    results.push({
      type: 'team_delete',
      timestamp
    });
  }
  else if (block.name === 'SendMessage') {
    const msgType = block.input?.type;
    if (msgType === 'message' || msgType === 'broadcast') {
      results.push({
        type: 'team_message',
        sender: 'lead',
        recipient: block.input?.recipient || null,
        content: block.input?.content || '',
        messageType: msgType,
        timestamp
      });
    } else {
      // Other SendMessage types (shutdown_request, etc.) - emit as generic tool
      results.push({
        type: 'tool',
        tool: block.name,
        input: block.input || {},
        toolUseId: block.id || null,
        timestamp
      });
    }
  }
  // Other tools
  else {
    results.push({
      type: 'tool',
      tool: block.name || 'unknown',
      input: block.input || {},
      toolUseId: block.id || null,
      timestamp
    });
  }

  return results;
}

/**
 * Handle a user-type log entry (tool results, meta messages, human input, permissionMode).
 * Returns a results array, or null to signal the entry should be skipped entirely.
 */
function handleUserEntry(entry, sessionData, parserState, pendingTaskIds, taskIdMap, timestamp) {
  const results = [];

  // Skip Task (subagent) tool results entirely - their output is streamed
  // via the subagent_output channel. Task results have agentId in toolUseResult.
  if (entry.toolUseResult?.agentId) {
    return null;
  }

  // Tool result - always emit when toolUseResult exists (even if no output)
  // This signals the tool completed, which is needed to dismiss permission cards
  if (entry.toolUseResult) {
    // Extract tool_use_id from content blocks for correlation with tool_use
    let toolUseId = null;
    if (Array.isArray(entry.message?.content)) {
      const resultBlock = entry.message.content.find(b => b.type === 'tool_result');
      toolUseId = resultBlock?.tool_use_id || null;
    }

    // Map TaskCreate tool_result to real task ID
    if (toolUseId && pendingTaskIds.has(toolUseId)) {
      const pendingId = pendingTaskIds.get(toolUseId);
      const result = stripAnsi(entry.toolUseResult.stdout || entry.toolUseResult.stderr || '');
      // TaskCreate result text contains "Created task N: ..." or "id: N"
      const idMatch = result.match(/(?:task\s+#?|id[:\s]+)(\d+)/i);
      if (idMatch) {
        taskIdMap.set(idMatch[1], pendingId);
      }
      pendingTaskIds.delete(toolUseId);
    }

    // Parse TaskList tool_result for authoritative task snapshot — only when
    // the tool_result corresponds to an actual TaskList tool_use (CONS-005).
    const isTaskListResult = toolUseId && sessionData?.pendingTaskListIds?.has(toolUseId);
    if (isTaskListResult) {
      sessionData.pendingTaskListIds.delete(toolUseId);
      const resultText = stripAnsi(entry.toolUseResult.stdout || entry.toolUseResult.stderr || '');
      const taskListItems = parseTaskListResult(resultText);
      if (taskListItems && taskListItems.length > 0) {
        sessionData.tasks.clear();
        for (const task of taskListItems) {
          const mappedId = taskIdMap.get(String(task.id)) || String(task.id);
          sessionData.tasks.set(mappedId, {
            id: mappedId,
            subject: task.subject,
            status: task.status,
            description: task.description || null,
            activeForm: task.activeForm || null
          });
        }
        results.push({
          type: 'task_list',
          tasks: Array.from(sessionData.tasks.values())
        });
      }
    }

    // permissionToolMap cleanup is TTL-based (600s) — not deleted here
    // because the user may click "Always Allow" after tool_result arrives.
    // But emit permission_resolved so clients can dismiss permission cards.
    if (toolUseId && sessionData?.permissionToolMap?.has(toolUseId)) {
      results.push({
        type: 'permission_resolved',
        toolUseId,
        timestamp
      });
    }

    const result = entry.toolUseResult.stdout || entry.toolUseResult.stderr || '';
    results.push({
      type: 'tool_result',
      content: stripAnsi(result.trim()) || '(completed)',
      isError: !!entry.toolUseResult.stderr && !entry.toolUseResult.stdout,
      toolUseId,
      timestamp
    });
  }
  // Auto-compaction: summary injected after context window compressed
  else if (entry.isCompactSummary) {
    return [{ type: 'compaction_complete', content: 'Context compacted', timestamp }];
  }
  // Skip meta-injected messages (skill definitions, system context)
  else if (entry.isMeta) {
    // These are CLI-injected messages (e.g. expanded skill prompts) — not user input
    return null;
  }
  // Human input
  else if (entry.message?.content) {
    const content = entry.message.content;
    if (typeof content === 'string') {
      // Skip command invocation wrappers (e.g. /compact, /help)
      if (content.includes('<command-message>') || content.includes('<command-name>')) {
        return null;
      }
      // Local command output — detect compaction completion
      if (content.includes('<local-command-stdout>')) {
        if (content.includes('Compacted')) {
          return [{ type: 'compaction_complete', content: 'Context compacted', timestamp }];
        }
        return null;
      }
      results.push({
        type: 'user',
        content: content,
        timestamp
      });
    } else if (Array.isArray(content)) {
      // Check for actual user text (not tool results)
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          results.push({
            type: 'user',
            content: block.text,
            timestamp
          });
        }
        // Skip tool_result blocks in user messages - we handle those via toolUseResult
      }
    }
  }

  // Extract permissionMode from user entries (present on human-typed messages)
  if (entry.permissionMode) {
    results.push({ type: 'mode_change', mode: entry.permissionMode, timestamp });
  }

  return results;
}

function parseLogEntry(entry, sessionData, parserState) {
  const { pendingTaskIds, taskIdMap } = parserState;
  const results = [];
  const timestamp = entry.timestamp || new Date().toISOString();

  // Handle progress entries - broadcast status updates with random spinner verb
  if (entry.type === 'progress') {
    return [{
      type: 'status_update',
      content: `${getRandomSpinnerVerb()}...`,
      timestamp: entry.timestamp || new Date().toISOString()
    }];
  }

  // Skip system entries
  if (entry.type === 'system') return null;

  // Note: compaction is detected via <local-command-stdout> containing "Compacted"
  // in the user entry handler below (not via a top-level type)

  // Assistant messages - extract text and tool uses from message.content
  if (entry.type === 'assistant' && entry.message?.content) {
    const content = entry.message.content;

    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text' && block.text) {
          results.push({ type: 'assistant', content: block.text, timestamp });
        } else if (block.type === 'thinking') {
          results.push({ type: 'status_update', content: `${getRandomSpinnerVerb()}...`, timestamp });
        } else if (block.type === 'tool_use') {
          results.push(...handleToolUseBlock(block, sessionData, parserState, timestamp));
        }
      }
    } else if (typeof content === 'string') {
      results.push({ type: 'assistant', content: content, timestamp });
    }
  }

  // User messages - could be human input or tool results
  if (entry.type === 'user') {
    const userResults = handleUserEntry(entry, sessionData, parserState, pendingTaskIds, taskIdMap, timestamp);
    if (userResults === null) return null;
    results.push(...userResults);
  }

  // Return first result, or null if none
  // For multiple results (like text + tool use), we'll broadcast them separately
  if (results.length === 0) return null;
  if (results.length === 1) return results[0];

  // Multiple items - return as array for special handling
  return results;
}

module.exports = {
  MAX_MILESTONES,
  createParserState,
  detectMilestone,
  extractMilestones,
  parseLogEntry
};
