const chokidar = require('chokidar');
const path = require('path');
const fsp = require('fs').promises;
const { MAX_READ_SIZE, calculateContextPercentage } = require('./utils');

const SUBAGENT_IDLE_TIMEOUT = 30000; // 30 seconds of inactivity = stopped
const SUBAGENT_TOOL_THROTTLE_MS = 500;

// Throttle subagent_tool messages to prevent flooding iOS with re-renders
const subagentToolThrottles = new Map(); // agentId → lastSentTimestamp

/**
 * Create watcher functions with injected dependencies.
 * @param {Object} deps
 * @param {Map} deps.activeSessions
 * @param {Function} deps.broadcastToClients
 * @param {Function} deps.parseLogEntry
 * @param {Function} deps.detectMilestone
 * @param {Object} deps.parserState
 * @param {Function} deps.getSessionStatus
 * @param {Function} deps.loadAllowedTools
 * @param {Function} deps.discoverSessions
 * @param {Function} deps.getActiveClaude
 */
function createWatcher(deps) {
  const {
    activeSessions,
    broadcastToClients,
    parseLogEntry,
    detectMilestone,
    parserState,
    getSessionStatus,
    loadAllowedTools,
    discoverSessions,
    getActiveClaude
  } = deps;

  async function watchSession(sessionId) {
    // If already watching, verify the process is still alive before returning cached data.
    // Prevents stale sessions from persisting after the Claude process exits.
    if (activeSessions.has(sessionId)) {
      const sd = activeSessions.get(sessionId);
      const sessionTty = sd.session?.tty;
      if (sessionTty && getActiveClaude) {
        try {
          const activeProcesses = await getActiveClaude();
          const stillAlive = activeProcesses.some(p => p.tty === sessionTty);
          if (!stillAlive) {
            console.log(`[Watch] Session ${sessionId.substring(0, 8)} stale (no Claude process in ${sessionTty}), cleaning up`);
            unwatchSession(sessionId);
            // Fall through to normal discovery (will return null since process is gone)
          } else {
            return sd.session;
          }
        } catch (e) {
          // getActiveClaude failed (tmux not running, etc.) — return cached data as fallback
          console.debug(`[Watch] Process liveness check failed: ${e.message}, returning cached session`);
          return sd.session;
        }
      } else {
        return sd.session;
      }
    }

    const sessions = await discoverSessions();
    const session = sessions.find(s => s.id === sessionId);

    if (!session || !session.logFile) {
      return null;
    }

    // Track file position to only read new content
    let lastPosition = 0;
    try {
      const stats = await fsp.stat(session.logFile);
      lastPosition = stats.size;
    } catch (e) {
      // File might not exist yet
    }

    // Watch the log file for changes
    const watcher = chokidar.watch(session.logFile, {
      persistent: true,
      usePolling: true,   // Use polling - FSEvents can miss updates
      interval: 500,      // Poll every 500ms
      binaryInterval: 500
      // NOTE: No awaitWriteFinish — it suppresses/coalesces change events on
      // continuously-written log files, causing output to silently stop updating.
      // Partial lines are handled by the lastNewlineIndex guard below.
    });

    // Guard: prevent concurrent reads when fallback poll overlaps with chokidar
    let processing = false;

    // Deferred permission broadcast: hold permission_requests for one poll cycle
    // to let auto-approved tool_results arrive in the next batch. Same pattern as
    // subagent watcher — prevents false permission prompts when Claude Code
    // auto-approves a tool between poll cycles.
    const pendingMainPermissions = new Map(); // toolUseId -> item

    async function processLogChanges() {
      if (processing) return;
      processing = true;
      try {
        // Loop to drain all available data (handles batches > MAX_READ_SIZE)
        let continueReading = true;
        while (continueReading) {
          continueReading = false;
          const stats = await fsp.stat(session.logFile);

          // Handle file truncation/rotation
          if (stats.size < lastPosition) {
            console.log(`[Watcher] File truncated, resetting position from ${lastPosition} to 0`);
            lastPosition = 0;
          }

          if (stats.size > lastPosition) {
            const bytesToRead = Math.min(stats.size - lastPosition, MAX_READ_SIZE);
            const fh = await fsp.open(session.logFile, 'r');
            const buffer = Buffer.alloc(bytesToRead);
            try {
              await fh.read(buffer, 0, bytesToRead, lastPosition);
            } finally {
              await fh.close();
            }

            const newContent = buffer.toString('utf8');
            const lastNewlineIndex = newContent.lastIndexOf('\n');
            if (lastNewlineIndex === -1) break; // No complete lines yet

            const completeContent = newContent.substring(0, lastNewlineIndex);
            // Calculate byte length of consumed content (including the newline)
            // so lastPosition stays aligned with the file's byte offset
            const consumedBytes = Buffer.byteLength(completeContent + '\n', 'utf8');
            const lines = completeContent.split('\n').filter(line => line.trim());

            let linesProcessed = false;
            // Parse all lines first, then filter auto-approved permissions
            const allItems = [];
            for (const line of lines) {
              try {
                const entry = JSON.parse(line);

                // Skip Task (subagent) tool results — streamed via subagent_output
                // But signal completion immediately instead of waiting for 30s idle timeout
                if (entry.type === 'user' && entry.toolUseResult?.agentId) {
                  stopSubagent(sessionId, entry.toolUseResult.agentId, 'task completed');
                  continue;
                }

                const parsed = parseLogEntry(entry, activeSessions.get(sessionId), parserState);
                if (parsed) {
                  linesProcessed = true;
                  const items = Array.isArray(parsed) ? parsed : [parsed];
                  allItems.push(...items);
                }
              } catch (e) {
                console.debug(`[Watcher] Skipped invalid JSON: ${e.message}`);
              }
            }

            // Phase 1: Collect resolved toolUseIds from this batch (same-batch filter)
            const resolvedToolUseIds = new Set(
              allItems
                .filter(i => i.type === 'tool_result' && i.toolUseId)
                .map(i => i.toolUseId)
            );

            // Phase 2: Resolve deferred permissions from previous poll cycle
            // that got a tool_result in this batch (cross-batch auto-approved).
            for (const [toolUseId] of pendingMainPermissions) {
              if (resolvedToolUseIds.has(toolUseId)) {
                pendingMainPermissions.delete(toolUseId);
              }
            }

            // Phase 3: Classify new items — same-batch auto-approved → convert
            // to 'tool', new permission_requests → defer to next poll cycle
            const filteredItems = [];
            for (const item of allItems) {
              if (item.type === 'permission_request' && item.toolUseId) {
                if (resolvedToolUseIds.has(item.toolUseId)) {
                  // Same-batch auto-approved: convert to regular tool so client
                  // can merge the tool_result into it (avoids orphaned tool_results)
                  filteredItems.push({ ...item, type: 'tool' });
                } else {
                  // Defer to next poll cycle — if no tool_result arrives, broadcast then
                  pendingMainPermissions.set(item.toolUseId, item);
                }
              } else if (item.type === 'permission_request' && !item.toolUseId) {
                // No toolUseId — can't defer (nothing to match against future tool_result).
                // Broadcast immediately. This matches subagent behavior.
                console.debug(`[Watcher] permission_request without toolUseId — broadcasting immediately: ${item.tool ?? 'unknown'}`);
                filteredItems.push(item);
              } else {
                filteredItems.push(item);
              }
            }

            for (const item of filteredItems) {
              if (item.type === 'mode_change') {
                const sessionData = activeSessions.get(sessionId);
                if (sessionData && sessionData.mode !== item.mode) {
                  sessionData.mode = item.mode;
                  console.log(`[Mode] Session ${sessionId.substring(0, 8)} → ${item.mode}`);
                  broadcastToClients({
                    type: 'mode_change',
                    sessionId: sessionId,
                    mode: item.mode
                  });
                }
              } else if (item.type === 'subagent_starting') {
                // Broadcast as top-level message so iOS .subagentStarting handler
                // catches it (not buried inside claude_output where description/agentType
                // fields are lost by ClaudeOutputData decoding)
                broadcastToClients({
                  type: 'subagent_starting',
                  sessionId: sessionId,
                  description: item.description,
                  agentType: item.agentType
                });
              } else if (item.type === 'permission_resolved') {
                // Broadcast as top-level so clients can dismiss permission cards
                broadcastToClients({
                  type: 'permission_resolved',
                  sessionId: sessionId,
                  toolUseId: item.toolUseId
                });
              } else if (item.type === 'task_create' || item.type === 'task_update' || item.type === 'task_list') {
                // Broadcast task messages as top-level so iOS decodes them as
                // .taskCreate / .taskUpdate / .taskList (not wrapped in claude_output)
                broadcastToClients(Object.assign({}, item, { sessionId }));
              } else if (item.type === 'team_create') {
                const sessionData = activeSessions.get(sessionId);
                if (sessionData) {
                  // Clear any previous team before setting new one
                  sessionData.activeTeam = {
                    name: item.teamName,
                    members: new Map(),
                    createdAt: item.timestamp
                  };
                  sessionData.teamMessages = [];
                }
                broadcastToClients({
                  type: 'team_create',
                  sessionId,
                  teamName: item.teamName,
                  timestamp: item.timestamp
                });
              } else if (item.type === 'team_delete') {
                const sessionData = activeSessions.get(sessionId);
                if (sessionData) {
                  sessionData.activeTeam = null;
                  sessionData.teamMessages = [];
                }
                broadcastToClients({
                  type: 'team_delete',
                  sessionId,
                  timestamp: item.timestamp
                });
              } else if (item.type === 'team_message') {
                const sessionData = activeSessions.get(sessionId);
                if (sessionData) {
                  const msg = {
                    sender: item.sender,
                    recipient: item.recipient,
                    content: item.content,
                    messageType: item.messageType,
                    timestamp: item.timestamp
                  };
                  sessionData.teamMessages.push(msg);
                  // Cap at 50 messages
                  if (sessionData.teamMessages.length > 50) {
                    sessionData.teamMessages = sessionData.teamMessages.slice(-50);
                  }
                }
                broadcastToClients({
                  type: 'team_message',
                  sessionId,
                  sender: item.sender,
                  recipient: item.recipient,
                  content: item.content,
                  messageType: item.messageType,
                  timestamp: item.timestamp
                });
              } else if (item.type === 'token_usage') {
                // Calculate context percentage from token usage and model
                const sd = activeSessions.get(sessionId);
                if (sd) {
                  const pct = calculateContextPercentage(item.usage, item.model);
                  if (pct !== null && pct !== sd.contextPercentage) {
                    sd.contextPercentage = pct;
                    if (item.model) sd.model = item.model;
                    broadcastToClients({
                      type: 'context_percentage',
                      sessionId: sessionId,
                      percentage: pct
                    });
                    // Detect auto-compaction: context crosses 95% threshold
                    if (pct >= 95 && !sd.compactionStartSent) {
                      sd.compactionStartSent = true;
                      broadcastToClients({
                        type: 'claude_output',
                        sessionId: sessionId,
                        data: { type: 'compaction_starting', content: 'Compacting context...', timestamp: new Date().toISOString() }
                      });
                    }
                  }
                }
              } else {
                broadcastToClients({
                  type: 'claude_output',
                  sessionId: sessionId,
                  data: item
                });
                // Reset compaction flag when compaction_complete is broadcast
                if (item.type === 'compaction_complete') {
                  const sd = activeSessions.get(sessionId);
                  if (sd) sd.compactionStartSent = false;
                }
              }
            }

            // Advance position BEFORE milestone detection so an error in
            // milestone logic never stalls the watcher (messages still flow).
            lastPosition += consumedBytes;

            // Milestone detection — run after broadcast loop
            try {
              const sd = activeSessions.get(sessionId);
              if (sd) {
                for (const item of filteredItems) {
                  const milestone = detectMilestone(item, sd);
                  if (milestone) {
                    broadcastToClients({
                      type: 'session_milestone',
                      sessionId: sessionId,
                      text: milestone.text,
                      timestamp: milestone.timestamp,
                      toolCount: milestone.toolCount
                    });
                  }
                }
              }
            } catch (e) {
              console.error('[Milestone] Detection error (non-fatal):', e.message);
            }

            if (linesProcessed) {
              const newStatus = await getSessionStatus(session.logFile);
              const sessionData = activeSessions.get(sessionId);
              if (sessionData && newStatus !== sessionData.lastStatus) {
                sessionData.lastStatus = newStatus;
                broadcastToClients({
                  type: 'session_status',
                  sessionId: sessionId,
                  status: newStatus
                });
              }
            }

            // More data remains — continue draining
            if (stats.size > lastPosition) {
              continueReading = true;
            }
          }
        }

        // Flush deferred permissions that survived all poll cycles.
        // Moved outside the while loop so permissions are flushed even when
        // no new content exists (fixes bug where deferred permissions were
        // trapped forever if the agent went idle waiting for user input).
        for (const [toolUseId, deferredItem] of pendingMainPermissions) {
          console.log(`[Watcher] Deferred permission confirmed pending: ${deferredItem.tool ?? deferredItem.type ?? 'unknown'}`);
          broadcastToClients({
            type: 'claude_output',
            sessionId: sessionId,
            data: deferredItem
          });
          pendingMainPermissions.delete(toolUseId);
        }
      } catch (e) {
        console.error('Error reading log file:', e);
      } finally {
        processing = false;
      }
    }

    watcher.on('change', () => processLogChanges());

    // Watch logs directory for awareness only — no auto-switch, which would cause
    // watchers to accidentally follow unrelated sessions sharing the same project dir
    const logsDir = path.dirname(session.logFile);
    const logsDirWatcher = chokidar.watch(logsDir, {
      persistent: true,
      ignoreInitial: true,
      depth: 0
    });

    logsDirWatcher.on('add', (newFile) => {
      if (newFile.endsWith('.jsonl')) {
        console.log(`[Session ${sessionId.substring(0, 8)}] New log file in project dir: ${path.basename(newFile)}`);

        // If this session has a pendingClear, the new file is the post-/clear session
        const sd = activeSessions.get(sessionId);
        if (sd && sd.pendingClear) {
          const newSessionId = path.basename(newFile, '.jsonl');
          if (newSessionId !== sessionId) {
            // Emit event for server.js to handle clear transition
            if (deps.onNewSessionAfterClear) {
              deps.onNewSessionAfterClear(sessionId, newSessionId, newFile);
            }
          }
        }
      }
    });

    // Fallback poll: catches missed chokidar events. macOS FSEvents and polling
    // can both miss rapid writes. Ensures output never silently stops updating.
    const FALLBACK_POLL_MS = 2000;
    const fallbackPoll = setInterval(() => processLogChanges(), FALLBACK_POLL_MS);

    const initialStatus = await getSessionStatus(session.logFile);

    const allowedTools = await loadAllowedTools(session.cwd);

    activeSessions.set(sessionId, {
      watcher,
      logsDirWatcher,
      pollInterval: fallbackPoll,
      session,
      lastPosition,
      lastStatus: initialStatus,
      mode: 'default',             // Current permission mode (updated from JSONL)
      contextPercentage: 0,        // Latest context % from statusline file
      contextPollInterval: null,   // Interval handle for /tmp/claude-ctx-* polling
      subagentWatchers: new Map(),  // Track subagent file watchers
      subagentPollIntervals: new Map(), // Fallback poll intervals per subagent
      subagentPositions: new Map(), // Track read positions per subagent
      subagentTimeouts: new Map(),  // Track inactivity timeouts per subagent
      subagentInfo: new Map(),      // Track subagent metadata for sync to new clients
      allowedTools,                 // Pre-allowed tools from Claude Code settings
      sessionGranted: new Set(),    // Tools granted "always" during this session
      permissionToolMap: new Map(), // toolUseId -> {tool, timestamp} for accurate "always" tracking
      tasks: new Map(),             // Accumulated task state: taskId -> {id, subject, status, description, activeForm}
      pendingTaskListIds: new Set(), // tool_use IDs for TaskList calls — gates parseTaskListResult to only run on TaskList results
      milestones: [],               // Ring buffer of milestone objects (max 20)
      toolBurstCount: 0,            // Running count of consecutive tool calls for milestone detection
      activeTeam: null,             // Active team: { name, members: Map, createdAt }
      teamMessages: [],             // Inter-teammate messages (capped at 50)
      // Event-based architecture fields (dedup, prompt recovery, liveness grace)
      pendingPrompts: new Map(),    // toolUseId → { promptId, type, tool, toolUseId, data, seq, timestamp }
      lastBroadcastSeq: 0,         // Monotonic counter, incremented in broadcastToClients
      recentEvents: [],            // Capped at 100 non-ephemeral events for reconnection delta
      failCount: 0                 // Liveness grace: reset on success, dead at >= 3
    });

    // Context percentage is now tracked from JSONL token_usage entries
    // in the main watcher loop (no longer from /tmp/claude-ctx-* files).
    const contextPollInterval = null;
    activeSessions.get(sessionId).contextPollInterval = contextPollInterval;

    // Watch for subagents in {sessionDir}/subagents/
    const subagentsDir = path.join(logsDir, sessionId, 'subagents');
    watchSubagentsDirectory(sessionId, subagentsDir);

    console.log(`[Session] Now watching: ${session.name} -> ${session.logFile}`);

    return session;
  }

  function unwatchSession(sessionId) {
    if (activeSessions.has(sessionId)) {
      const sessionData = activeSessions.get(sessionId);
      sessionData.watcher.close();
      sessionData.logsDirWatcher?.close();
      sessionData.subagentsDirWatcher?.close();
      sessionData.subagentsParentWatcher?.close();
      if (sessionData.pollInterval) clearInterval(sessionData.pollInterval);
      if (sessionData.contextPollInterval) clearInterval(sessionData.contextPollInterval);

      // Clean up subagent watchers
      sessionData.subagentWatchers?.forEach((watcher, agentId) => {
        watcher.close();
        console.log(`[Subagent] Stopped watching: ${agentId}`);
      });
      sessionData.subagentPollIntervals?.forEach(interval => clearInterval(interval));
      sessionData.subagentTimeouts?.forEach(timeout => clearTimeout(timeout));

      activeSessions.delete(sessionId);
    }
  }

  // ---- Subagent watching (internal) ----

  function watchSubagentsDirectory(sessionId, subagentsDir) {
    // Check if directory exists first
    fsp.access(subagentsDir).then(async () => {
      // Scan for recently active subagent files (modified within last 60 seconds)
      // These are likely still running and should be watched
      try {
        const files = await fsp.readdir(subagentsDir);
        const now = Date.now();
        for (const file of files) {
          if (file.endsWith('.jsonl')) {
            const filePath = path.join(subagentsDir, file);
            const stats = await fsp.stat(filePath);
            const ageMs = now - stats.mtimeMs;
            if (ageMs < 60000) { // Modified within last 60 seconds
              const agentId = file.replace('agent-', '').replace('.jsonl', '');
              console.log(`[Subagent] Found recently active: ${agentId} (${Math.round(ageMs/1000)}s old)`);
              watchSubagent(sessionId, agentId, filePath, false); // existing file
            }
          }
        }
      } catch (e) {
        console.error('[Subagent] Error scanning existing files:', e);
      }

      // Watch for new subagent files
      const subagentsDirWatcher = chokidar.watch(subagentsDir, {
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 }
      });

      subagentsDirWatcher.on('add', (filePath) => {
        if (filePath.endsWith('.jsonl')) {
          const agentId = path.basename(filePath, '.jsonl').replace('agent-', '');
          watchSubagent(sessionId, agentId, filePath, true); // new file
        }
      });

      // Store watcher for cleanup
      const sessionData = activeSessions.get(sessionId);
      if (sessionData) {
        sessionData.subagentsDirWatcher = subagentsDirWatcher;
      }
    }).catch(() => {
      // Directory doesn't exist yet - watch parent for its creation
      const parentDir = path.dirname(subagentsDir);
      const parentWatcher = chokidar.watch(parentDir, {
        persistent: true,
        ignoreInitial: true,
        depth: 0
      });

      parentWatcher.on('addDir', (dirPath) => {
        if (dirPath === subagentsDir) {
          parentWatcher.close();
          watchSubagentsDirectory(sessionId, subagentsDir);
        }
      });

      const sessionData = activeSessions.get(sessionId);
      if (sessionData) {
        sessionData.subagentsParentWatcher = parentWatcher;
      }
    });
  }

  async function watchSubagent(sessionId, agentId, logFile, isNew = true) {
    const sessionData = activeSessions.get(sessionId);
    if (!sessionData) return;

    // Already watching this subagent
    if (sessionData.subagentWatchers.has(agentId)) return;

    console.log(`[Subagent] Now watching: ${agentId} -> ${logFile} (${isNew ? 'new' : 'existing'})`);

    // Start from beginning to catch any content already written (fixes race condition
    // where permission requests are written before watcher is set up)
    sessionData.subagentPositions.set(agentId, 0);

    // Try to correlate with pending subagent description (within 10 seconds)
    let description = null;
    let agentType = null;
    let teamName = null;
    let memberName = null;
    const now = Date.now();
    for (const [timestamp, info] of parserState.pendingSubagentDescriptions) {
      if (now - timestamp < 10000) { // Within 10 seconds
        description = info.description;
        agentType = info.type;
        teamName = info.teamName || null;
        memberName = info.memberName || null;
        parserState.pendingSubagentDescriptions.delete(timestamp);
        break;
      } else if (now - timestamp > 30000) {
        // Clean up old entries
        parserState.pendingSubagentDescriptions.delete(timestamp);
      }
    }

    // Store and broadcast subagent start with correlated description
    const subagentData = {
      description: description || agentId.substring(0, 8),
      agentType: agentType || 'general',
      startTime: Date.now(),
      inputTokens: 0,
      outputTokens: 0,
      currentTool: null,
      teamName,
      memberName
    };
    sessionData.subagentInfo.set(agentId, subagentData);

    // If this subagent is a teammate, register it in the active team
    if (teamName && sessionData.activeTeam) {
      sessionData.activeTeam.members.set(memberName || agentId, {
        agentId,
        name: memberName || agentId,
        startTime: subagentData.startTime
      });
    }

    const broadcastMsg = {
      type: 'subagent_start',
      sessionId,
      agentId,
      description: subagentData.description,
      agentType: subagentData.agentType,
      timestamp: subagentData.startTime
    };
    if (teamName) broadcastMsg.teamName = teamName;
    if (memberName) broadcastMsg.memberName = memberName;
    broadcastToClients(broadcastMsg);

    // Set up file watcher
    const watcher = chokidar.watch(logFile, {
      persistent: true,
      usePolling: true,
      interval: 500,
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 }
    });

    // Deferred permission broadcast: hold permission_requests for one poll cycle
    // to let auto-approved tool_results arrive in the next batch. This prevents
    // flooding clients with stale permission prompts from bypassPermissions agents.
    const pendingPermissions = new Map(); // toolUseId -> item
    // Track resolved toolUseIds so the 5s verification timeout can check
    // if a tool_result arrived after auto-approve (prevents phantom fallback)
    const autoApproveResolved = new Set();

    // Handler for processing file content
    // Lock prevents concurrent reads (immediate read + chokidar change can race)
    let processing = false;
    const processFileContent = async (filePath) => {
      if (processing) return;
      // Guard against post-stopSubagent poll ticks (interval may fire once after clearInterval)
      if (!sessionData.subagentWatchers.has(agentId)) return;
      processing = true;
      try {
        const stats = await fsp.stat(filePath);
        let position = sessionData.subagentPositions.get(agentId) || 0;

        // Handle truncation
        if (stats.size < position) {
          position = 0;
        }

        // Collect resolved toolUseIds from new content (populated inside if-block)
        let resolvedToolUseIds = new Set();

        if (stats.size > position) {
          const bytesToRead = Math.min(stats.size - position, MAX_READ_SIZE);
          const fh = await fsp.open(filePath, 'r');
          const buffer = Buffer.alloc(bytesToRead);
          try {
            await fh.read(buffer, 0, bytesToRead, position);
          } finally {
            await fh.close();
          }

          const newContent = buffer.toString('utf8');
          const lastNewlineIndex = newContent.lastIndexOf('\n');
          if (lastNewlineIndex === -1) {
            processing = false;
            return;
          }

          const completeContent = newContent.substring(0, lastNewlineIndex);
          const consumedBytes = Buffer.byteLength(completeContent + '\n', 'utf8');
          const lines = completeContent.split('\n').filter(l => l.trim());

          // Parse all lines first, then filter auto-approved permissions
          const allItems = [];
          for (const line of lines) {
            try {
              const entry = JSON.parse(line);
              const parsed = parseLogEntry(entry, activeSessions.get(sessionId), parserState);
              if (parsed) {
                const items = Array.isArray(parsed) ? parsed : [parsed];
                for (const item of items) {
                  item.subagentId = agentId;
                  allItems.push(item);
                }
              }
            } catch (e) {
              // Skip invalid JSON
            }
          }

          // Collect resolved toolUseIds from this batch (same-batch filter)
          resolvedToolUseIds = new Set(
            allItems
              .filter(i => i.type === 'tool_result' && i.toolUseId)
              .map(i => i.toolUseId)
          );
          // Also add to persistent set for auto-approve verification
          for (const id of resolvedToolUseIds) autoApproveResolved.add(id);

          for (const item of allItems) {
            // Same-batch auto-approved — skip entirely
            if (item.type === 'permission_request' && item.toolUseId && resolvedToolUseIds.has(item.toolUseId)) {
              continue;
            }

            // Permission requests: defer to next poll cycle to catch
            // cross-batch auto-approvals (e.g. bypassPermissions agents where
            // tool_result arrives milliseconds after permission_request)
            if (item.type === 'permission_request' && item.toolUseId) {
              pendingPermissions.set(item.toolUseId, item);
              continue;
            }

            // ask_user_question: broadcast immediately (not permission-gated)
            if (item.type === 'ask_user_question') {
              console.log(`[Subagent ${agentId}] ${item.type}`);
              broadcastToClients({
                type: 'subagent_output',
                sessionId,
                agentId,
                data: item
              });
            }

            // Broadcast permission_resolved as top-level event (same as main watcher)
            if (item.type === 'permission_resolved') {
              broadcastToClients({
                type: 'permission_resolved',
                sessionId,
                toolUseId: item.toolUseId
              });
            }

            // Capture team lifecycle events from subagent JSONL (Team Lead calls TeamCreate/TeamDelete)
            if (item.type === 'team_create') {
              const sd = activeSessions.get(sessionId);
              if (sd) {
                sd.activeTeam = {
                  name: item.teamName,
                  members: new Map(),
                  createdAt: item.timestamp
                };
                sd.teamMessages = [];
              }
              broadcastToClients({
                type: 'team_create',
                sessionId,
                teamName: item.teamName,
                timestamp: item.timestamp
              });
            }
            if (item.type === 'team_delete') {
              const sd = activeSessions.get(sessionId);
              if (sd) {
                sd.activeTeam = null;
                sd.teamMessages = [];
              }
              broadcastToClients({
                type: 'team_delete',
                sessionId,
                timestamp: item.timestamp
              });
            }

            // Capture team messages from teammate subagents
            if (item.type === 'team_message') {
              const sd = activeSessions.get(sessionId);
              if (sd) {
                // Use the teammate's memberName as sender instead of generic 'lead'
                const info = sd.subagentInfo.get(agentId);
                const senderName = info?.memberName || agentId.substring(0, 8);
                const msg = {
                  sender: senderName,
                  recipient: item.recipient,
                  content: item.content,
                  messageType: item.messageType,
                  timestamp: item.timestamp
                };
                sd.teamMessages.push(msg);
                if (sd.teamMessages.length > 50) {
                  sd.teamMessages = sd.teamMessages.slice(-50);
                }
              }
              broadcastToClients({
                type: 'team_message',
                sessionId,
                sender: activeSessions.get(sessionId)?.subagentInfo.get(agentId)?.memberName || agentId.substring(0, 8),
                recipient: item.recipient,
                content: item.content,
                messageType: item.messageType,
                timestamp: item.timestamp
              });
            }

            // Emit specific events for tool usage (throttled activity card updates)
            if (item.type === 'tool') {
              // Update stored subagent info
              const info = sessionData.subagentInfo.get(agentId);
              if (info) {
                info.currentTool = item.tool;
              }
              // Throttle subagent_tool to max 1 per 500ms per agent
              const now = Date.now();
              const lastSent = subagentToolThrottles.get(agentId) || 0;
              if (now - lastSent >= SUBAGENT_TOOL_THROTTLE_MS) {
                subagentToolThrottles.set(agentId, now);
                broadcastToClients({
                  type: 'subagent_tool',
                  sessionId,
                  agentId,
                  tool: item.tool,
                  input: item.input
                });
              }
            }
            if (item.type === 'token_usage') {
              // Update stored subagent info
              const info = sessionData.subagentInfo.get(agentId);
              if (info) {
                info.inputTokens = (info.inputTokens || 0) + (item.input || 0);
                info.outputTokens = (info.outputTokens || 0) + (item.output || 0);
              }
              broadcastToClients({
                type: 'subagent_tokens',
                sessionId,
                agentId,
                input: item.input,
                output: item.output
              });
            }
          }

          sessionData.subagentPositions.set(agentId, position + consumedBytes);

          // Reset idle timeout
          resetSubagentIdleTimeout(sessionId, agentId);
        }

        // ALWAYS flush deferred permissions (even if no new content).
        // Previous bug: flush was inside the if-block, so permissions deferred
        // in the last batch before the subagent goes idle were never flushed.

        // Resolve deferred permissions that got a tool_result in this batch
        for (const [toolUseId] of pendingPermissions) {
          if (resolvedToolUseIds.has(toolUseId)) {
            pendingPermissions.delete(toolUseId);
          }
        }

        // Auto-approve surviving deferred permissions by injecting 'y' into
        // the session's TTY. If auto-approve fails or no tool_result appears
        // within 5 seconds, broadcast to clients as fallback (user must approve).
        if (pendingPermissions.size > 0) {
          const tty = sessionData.session?.tty;
          const permissionsToApprove = [...pendingPermissions.entries()];
          pendingPermissions.clear();

          for (let pi = 0; pi < permissionsToApprove.length; pi++) {
            const [toolUseId, deferredItem] = permissionsToApprove[pi];
            let autoApproved = false;
            // [CONS-001] Target format validation delegated to the platform adapter
            // via injectCommandToTty → adapter.injectCommand → validateTarget.
            // The adapter rejects invalid targets (null, malformed pane IDs, etc.).
            if (tty) {
              try {
                const { injectCommandToTty } = require('./command-injection');
                await injectCommandToTty('y', tty);
                console.log(`[Subagent ${agentId}] Auto-approved ${deferredItem.tool ?? 'unknown'}`);
                autoApproved = true;
              } catch (e) {
                console.error(`[Subagent ${agentId}] Auto-approve failed: ${e.message}`);
              }
            } else {
              console.log(`[Subagent ${agentId}] No TTY/pane for auto-approve: ${deferredItem.tool ?? 'unknown'}`);
            }

            if (!autoApproved) {
              // TTY write failed or unavailable — broadcast to clients as fallback
              console.log(`[Subagent ${agentId}] Fallback: broadcasting permission to clients`);
              broadcastToClients({
                type: 'claude_output',
                sessionId,
                data: deferredItem
              });
            } else {
              // TTY write succeeded — verify tool_result appears within 5s.
              // If not, broadcast as fallback (TTY write may have gone to wrong process).
              const verifyItem = { ...deferredItem };
              const verifyId = toolUseId;
              setTimeout(() => {
                // Check if subagent is still active and permission wasn't resolved
                const sd = activeSessions.get(sessionId);
                if (!sd) return;
                // If the subagent watcher is gone, it completed (permission was resolved)
                if (!sd.subagentWatchers.has(agentId)) return;
                // If a tool_result already arrived for this toolUseId, auto-approve worked
                if (autoApproveResolved.has(verifyId)) return;
                console.log(`[Subagent ${agentId}] Auto-approve verification timeout for ${verifyItem.tool ?? 'unknown'} — broadcasting fallback`);
                broadcastToClients({
                  type: 'claude_output',
                  sessionId,
                  data: verifyItem
                });
              }, 5000);
            }

            // Small delay between approvals to let CLI process each one
            if (pi < permissionsToApprove.length - 1) {
              await new Promise(r => setTimeout(r, 200));
            }
          }
        }
      } catch (e) {
        console.error(`[Subagent ${agentId}] Error:`, e.message);
      } finally {
        processing = false;
      }
    };

    // Bind handler to change events
    watcher.on('change', processFileContent);

    // Fallback poll: ensures deferred pendingPermissions are flushed even when
    // the subagent writes no new content (e.g., waiting for user permission).
    // Without this, permissions can be trapped in the pendingPermissions Map
    // forever if all arrive in one batch and the agent goes idle.
    const SUBAGENT_FALLBACK_POLL_MS = 2000;
    const subagentFallbackPoll = setInterval(() => processFileContent(logFile), SUBAGENT_FALLBACK_POLL_MS);
    sessionData.subagentPollIntervals.set(agentId, subagentFallbackPoll);

    sessionData.subagentWatchers.set(agentId, watcher);

    // IMMEDIATELY read existing content (fixes race condition where subagent
    // writes everything before watcher is ready)
    console.log(`[Subagent ${agentId}] Triggering immediate read of ${logFile}`);
    processFileContent(logFile);

    // Set initial idle timeout
    resetSubagentIdleTimeout(sessionId, agentId);
  }

  function resetSubagentIdleTimeout(sessionId, agentId) {
    const sessionData = activeSessions.get(sessionId);
    if (!sessionData) return;

    // Clear existing timeout
    const existingTimeout = sessionData.subagentTimeouts.get(agentId);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    // Set new timeout
    const timeout = setTimeout(() => {
      stopSubagent(sessionId, agentId);
    }, SUBAGENT_IDLE_TIMEOUT);

    sessionData.subagentTimeouts.set(agentId, timeout);
  }

  function stopSubagent(sessionId, agentId, reason) {
    const sessionData = activeSessions.get(sessionId);
    if (!sessionData) return;

    const watcher = sessionData.subagentWatchers.get(agentId);
    if (watcher) {
      watcher.close();
      sessionData.subagentWatchers.delete(agentId);
      sessionData.subagentPositions.delete(agentId);
      sessionData.subagentInfo.delete(agentId);
      subagentToolThrottles.delete(agentId);

      const pollInterval = sessionData.subagentPollIntervals.get(agentId);
      if (pollInterval) {
        clearInterval(pollInterval);
        sessionData.subagentPollIntervals.delete(agentId);
      }

      const timeout = sessionData.subagentTimeouts.get(agentId);
      if (timeout) {
        clearTimeout(timeout);
        sessionData.subagentTimeouts.delete(agentId);
      }

      console.log(`[Subagent ${agentId}] Stopped (${reason || 'idle timeout'})`);

      broadcastToClients({
        type: 'subagent_stop',
        sessionId,
        agentId,
        timestamp: Date.now()
      });
    }
  }

  return { watchSession, unwatchSession };
}

module.exports = { createWatcher };
