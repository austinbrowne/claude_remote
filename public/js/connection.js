// ============================================
// WebSocket Send Helper
// ============================================
let pendingInjectResolve = null;

function wsSend(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    showToast('Not connected', 'error');
    return false;
  }
  try {
    ws.send(JSON.stringify(payload));
    return true;
  } catch (e) {
    showToast('Send failed', 'error');
    return false;
  }
}

// Send inject command and wait for completion
function injectAndWait(command, timeout = 5000) {
  return new Promise((resolve, reject) => {
    if (!wsSend({ action: 'inject', command, sessionId: currentSessionId })) {
      reject(new Error('Failed to send'));
      return;
    }
    const timer = setTimeout(() => {
      pendingInjectResolve = null;
      reject(new Error('Inject timeout'));
    }, timeout);
    pendingInjectResolve = (success) => {
      clearTimeout(timer);
      pendingInjectResolve = null;
      if (success) resolve();
      else reject(new Error('Inject failed'));
    };
  });
}

// ============================================
// WebSocket Connection
// ============================================

// Shared WebSocket handler setup (DRY - used by connect and reconnect)
function setupWebSocketHandlers(websocket, sessionToRewatch) {
  websocket.onopen = () => {
    // Authenticate via message instead of URL query (more secure)
    websocket.send(JSON.stringify({ action: 'auth', token: authToken }));
    // Save session for re-watching after auth succeeds
    if (sessionToRewatch) {
      pending.reconnectSession = sessionToRewatch;
    }
  };

  websocket.onclose = (event) => {
    const statusDot = document.getElementById('statusDot');
    statusDot.classList.remove('connected');

    if (event.code === 4001) {
      statusDot.classList.remove('reconnecting');
      showToast('Invalid token', 'error');
      disconnect();
      return;
    }

    // Schedule reconnect with exponential backoff
    if (authToken && !reconnectTimeout) {
      statusDot.classList.add('reconnecting');
      const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
      showToast(`Disconnected - reconnecting in ${Math.round(delay/1000)}s...`, 'error');
      reconnectAttempts++;

      reconnectTimeout = setTimeout(() => {
        reconnectTimeout = null;
        reconnect();
      }, delay);
    } else {
      statusDot.classList.remove('reconnecting');
    }
  };

  websocket.onerror = () => {
    showToast('Connection error', 'error');
  };

  websocket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleMessage(msg);
    } catch (e) {
      console.error('Message handler error:', e);
    }
  };
}

function connect() {
  authToken = document.getElementById('token').value;
  if (!authToken) {
    showToast('Please enter a token', 'error');
    return;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  // Connect without token in URL (security: prevents token in logs/history)
  const wsUrl = `${protocol}//${window.location.host}`;

  ws = new WebSocket(wsUrl);
  setupWebSocketHandlers(ws, null);
}

function disconnect() {
  if (reconnectTimeout) {
    clearTimeout(reconnectTimeout);
    reconnectTimeout = null;
  }
  if (pingTimeout) {
    clearTimeout(pingTimeout);
    pingTimeout = null;
  }
  if (pingInterval) {
    clearInterval(pingInterval);
    pingInterval = null;
  }
  safeRemoveItem(localStorage, 'claude_remote_token');
  authToken = '';
  // Reset session state
  sessionState = SESSION_STATE.IDLE;
  pendingSessionId = null;
  currentSessionId = null;
  if (ws) {
    ws.close();
    ws = null;
  }
  document.getElementById('mainApp').classList.remove('active');
  document.getElementById('authScreen').classList.remove('hidden');
  document.getElementById('token').value = '';
  closeSettings();
}

// ============================================
// Reconnection Logic (iOS Safari frozen socket fix)
// ============================================

function handleVisibilityChange() {
  if (document.visibilityState === 'visible' && authToken) {
    const now = Date.now();
    const backgroundDuration = now - lastVisibleTime;

    // If backgrounded for more than 5 seconds, force full reconnect
    // This prevents iOS Safari from sending stale buffered messages
    if (backgroundDuration > 5000) {
      console.log(`[Visibility] Backgrounded for ${backgroundDuration}ms, forcing reconnect`);
      forceReconnect();

      // Clear input if it matches the last sent command (iOS form restoration issue)
      const input = document.getElementById('commandInput');
      if (input && input.value.trim() === lastSentCommand.text) {
        console.log('[Visibility] Clearing stale input that matches last sent command');
        input.value = '';
        autoResize(input);
      }
    } else {
      checkConnectionHealth();
    }

    // Restart trigger listening when returning to foreground (iOS kills mic in background)
    if (settings.triggerEnabled && triggerState === TRIGGER_STATE.LISTENING) {
      setTimeout(() => {
        if (triggerState !== TRIGGER_STATE.IDLE) {
          try { recognition.start(); } catch (e) {}
        }
      }, 500);
    }
  } else if (document.visibilityState === 'hidden') {
    lastVisibleTime = Date.now();
  }
}

function checkConnectionHealth() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    if (!reconnectTimeout) reconnect();
    return;
  }

  // Send ping, expect pong within 3 seconds
  if (pingTimeout) clearTimeout(pingTimeout);
  pingTimeout = setTimeout(() => forceReconnect(), PING_TIMEOUT_MS);

  try {
    ws.send(JSON.stringify({ action: 'ping' }));
  } catch (e) {
    clearTimeout(pingTimeout);
    forceReconnect();
  }
}

function forceReconnect() {
  if (pingTimeout) clearTimeout(pingTimeout);
  pingTimeout = null;
  if (pingInterval) clearInterval(pingInterval);
  pingInterval = null;
  if (ws) {
    ws.onclose = null;
    ws.onerror = null;
    try { ws.close(); } catch (e) {}
    ws = null;
  }
  const statusDot = document.getElementById('statusDot');
  statusDot.classList.remove('connected');
  statusDot.classList.add('reconnecting');
  reconnect();
}

function reconnect() {
  if (reconnectTimeout) return;
  if (!authToken) return;

  const savedSessionId = currentSessionId;
  currentSessionId = null;

  const statusDot = document.getElementById('statusDot');
  statusDot.classList.remove('connected');
  statusDot.classList.add('reconnecting');
  showToast('Reconnecting...', 'error');

  // Create new connection (without token in URL for security)
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}`;
  ws = new WebSocket(wsUrl);
  setupWebSocketHandlers(ws, savedSessionId);
}

// ============================================
// Message Handling
// ============================================
// Debug mode (toggle in Settings > Developer)

function handleMessage(msg) {
  debugMsgCount++;
  // Debug ALL message types to trace the flow
  if (debugMode) {
    const info = msg.type === 'subagent_output'
      ? `🤖 ${msg.agentId?.substring(0,6)} → ${msg.data?.type}`
      : msg.type === 'claude_output'
      ? `📤 ${msg.data?.type}`
      : msg.type;
    showToast(`#${debugMsgCount}: ${info}`, 'success');
  }
  switch (msg.type) {
    case 'auth_result':
      if (msg.success) {
        // Save token only after successful auth
        safeSetItem(localStorage, 'claude_remote_token', authToken);
        document.getElementById('authScreen').classList.add('hidden');
        document.getElementById('mainApp').classList.add('active');
        const statusDot = document.getElementById('statusDot');
        statusDot.classList.remove('reconnecting');
        statusDot.classList.add('connected');
        reconnectAttempts = 0;

        // Start heartbeat to detect dead connections
        if (pingInterval) clearInterval(pingInterval);
        pingInterval = setInterval(() => checkConnectionHealth(), PING_INTERVAL_MS);

        // Re-watch session if this was a reconnect
        if (pending.reconnectSession) {
          wsSend({ action: 'watch_session', sessionId: pending.reconnectSession });
          pending.reconnectSession = null;
          showToast('Reconnected!', 'success');
        } else {
          showToast('Connected!', 'success');
        }
      } else {
        showToast(msg.error || 'Authentication failed', 'error');
        disconnect();
      }
      break;

    case 'sessions':
      updateSessionList(msg.data);
      break;

    case 'watching':
      // Confirm session switch - only accept if this was the pending session
      if (sessionState === SESSION_STATE.SWITCHING && msg.sessionId === pendingSessionId) {
        currentSessionId = msg.sessionId;
        sessionState = SESSION_STATE.ACTIVE;
        pendingSessionId = null;
      } else if (sessionState === SESSION_STATE.IDLE) {
        // Initial connection or reconnection
        currentSessionId = msg.sessionId;
        sessionState = SESSION_STATE.ACTIVE;
      }
      // Update mobile header and hide splash
      updateSessionLabel();
      document.getElementById('sessionPickerSplash')?.classList.add('hidden');
      // Process any queued prompt that arrived during state transition
      if (sessionState === SESSION_STATE.ACTIVE && pendingPromptMessage) {
        const queued = pendingPromptMessage;
        pendingPromptMessage = null;
        if (queued.sessionId === currentSessionId) {
          if (queued.data.type === 'ask_user_question') {
            showStructuredPrompt(queued.data.questions);
          } else if (queued.data.type === 'permission_request') {
            showPromptCard({
              type: 'permission',
              text: `Allow ${queued.data.tool}?`,
              tool: queued.data.tool,
              toolUseId: queued.data.toolUseId || null,
              command: queued.data.tool === 'Bash' ? queued.data.input?.command : `${queued.data.tool}: ${queued.data.input?.file_path}`,
              isDestructive: queued.data.tool === 'Bash' && /\brm\b|\bdelete\b|\bdrop\b/.test((queued.data.input?.command || '').toLowerCase())
            });
          }
        }
      }
      break;

    case 'history':
      renderHistory(msg.data);
      break;

    case 'claude_output':
      // Queue prompt messages that arrive during state transitions (not ACTIVE yet)
      if (sessionState !== SESSION_STATE.ACTIVE || msg.sessionId !== currentSessionId) {
        if (msg.data.type === 'ask_user_question' || msg.data.type === 'permission_request') {
          pendingPromptMessage = msg;
        }
        break;
      }
      // Only process messages for current session when in ACTIVE state
      // Handle structured AskUserQuestion prompts
      if (msg.data.type === 'ask_user_question') {
        showStructuredPrompt(msg.data.questions);
        break;
      }
      // Handle permission requests (Bash, Write, Edit, etc.)
      // Delay showing card - if tool_result comes quickly, it was auto-approved
      if (msg.data.type === 'permission_request') {
        const input = msg.data.input || {};
        const tool = msg.data.tool;
        const cmd = tool === 'Bash' ? (input.command || '') : `${tool}: ${input.file_path || 'unknown'}`;
        const isDestructive = tool === 'Bash' && /\brm\b|\bdelete\b|\bdrop\b/.test(cmd.toLowerCase());

        // Display as a tool message so user sees what tool is being called
        appendMessage({
          type: 'tool',
          tool: tool,
          input: input
        });

        // Store pending card and wait before showing (allows auto-approval to cancel)
        pending.permissionCard = { tool, cmd, isDestructive, toolUseId: msg.data.toolUseId || null };
        pending.permissionTimeout = setTimeout(() => {
          if (pending.permissionCard) {
            pending.lastPermissionCardTime = Date.now();
            showPromptCard({
              type: 'permission',
              text: `Allow ${pending.permissionCard.tool}?`,
              tool: pending.permissionCard.tool,
              toolUseId: pending.permissionCard.toolUseId,
              command: pending.permissionCard.cmd,
              isDestructive: pending.permissionCard.isDestructive
            });
            pending.permissionCard = null;
          }
        }, PERMISSION_CARD_DELAY_MS);
        break;
      }
      // Cancel pending permission card on tool_result (command was auto-approved)
      if (msg.data.type === 'tool_result') {
        if (pending.permissionTimeout) {
          clearTimeout(pending.permissionTimeout);
          pending.permissionTimeout = null;
          pending.permissionCard = null;
        }
        // In multi-agent mode, only dismiss the specific matching permission —
        // NOT all permissions (other agents may still be waiting).
        // If toolUseId provided, dismiss only the matching one.
        const resultToolUseId = msg.data.toolUseId;
        if (resultToolUseId) {
          for (let i = promptQueue.length - 1; i >= 0; i--) {
            if (promptQueue[i].toolUseId === resultToolUseId) {
              promptQueue.splice(i, 1);
              break;
            }
          }
          if (currentPrompt?.toolUseId === resultToolUseId) {
            hidePromptCard();
          }
        } else {
          // Legacy fallback (no toolUseId): dismiss current permission card only
          if (currentPrompt?.type === 'permission') {
            hidePromptCard();
          }
        }
        // Merge result into matching tool card (like iOS), or append standalone
        mergeOrAppendToolResult(msg.data);
        break;
      }
      // Compaction complete — show toast and skip chat
      if (msg.data.type === 'compaction_complete') {
        showToast('Context compacted', 'success');
        break;
      }
      // Dedupe user messages we just sent
      if (msg.data.type === 'user') {
        if (shouldDedupeMessage(msg.data.content)) {
          break; // Skip this duplicate
        }
      }
      // Route status updates to the status handler
      if (msg.data.type === 'status_update') {
        handleStatusUpdate(msg.data);
        break;
      }
      // Skip subagent_starting - it's handled via subagent_start message
      if (msg.data.type === 'subagent_starting') {
        break;
      }
      appendMessage(msg.data);

      // TTS for assistant messages
      if (msg.data.type === 'assistant' && settings.ttsEnabled) {
        speak(msg.data.content);
      }

      // TTS for tool calls (if enabled)
      if (msg.data.type === 'tool' && settings.speakTools) {
        speak(`Using tool: ${msg.data.tool}`);
      }

      // Notification
      if (msg.data.type === 'assistant' && settings.notifyEnabled && document.hidden) {
        sendNotification('Claude Response', msg.data.content.substring(0, 100));
      }
      break;

    case 'session_status':
      updateSessionStatus(msg.sessionId, msg.status);
      // Auto-dismiss prompt if session became active (user responded elsewhere)
      if (msg.sessionId === currentSessionId && msg.status === 'processing' && currentPrompt) {
        hidePromptCard();
      }
      break;

    case 'status_update':
      handleStatusUpdate(msg);
      break;

    case 'token_usage':
      handleTokenUsage(msg);
      break;

    case 'task_create':
      handleTaskCreate(msg);
      break;

    case 'task_update':
      handleTaskUpdate(msg);
      break;

    case 'task_list':
      handleTaskList(msg);
      break;

    case 'subagent_starting': {
      // Use memberName as display for teammates, fall back to description
      const displayDesc = msg.memberName || msg.description;
      // Create persistent inline activity card (matches iOS SubagentActivityCard)
      const card = createSubagentActivityCard(displayDesc, msg.agentType);
      if (msg.teamName) card.classList.add('teammate');
      const outputArea = document.getElementById('outputArea');
      outputArea.appendChild(card);
      outputArea.scrollTop = outputArea.scrollHeight;

      // Queue for correlation with subagent_start (FIFO, matches iOS pendingSubagentMessages)
      const autoCompleteTimeout = setTimeout(() => {
        // 30s auto-complete for orphaned starting cards (matches iOS)
        updateSubagentCardStatus(card, 'completed');
        const idx = pendingSubagentCards.findIndex(p => p.element === card);
        if (idx !== -1) pendingSubagentCards.splice(idx, 1);
      }, 30000);
      pendingSubagentCards.push({ description: msg.description, element: card, timeout: autoCompleteTimeout });

      // Also store for legacy correlation
      pendingSubagentInfo = { description: msg.description, type: msg.agentType, timestamp: Date.now() };
      break;
    }

    case 'subagent_start': {
      // Correlate with pending card (FIFO match by description, matches iOS)
      const info = pendingSubagentInfo || {};
      let matchedCard = null;
      const pendingIdx = pendingSubagentCards.findIndex(p => p.description === msg.description);
      if (pendingIdx !== -1) {
        const pending = pendingSubagentCards[pendingIdx];
        clearTimeout(pending.timeout);
        matchedCard = pending.element;
        matchedCard.dataset.agentId = msg.agentId;
        updateSubagentCardStatus(matchedCard, 'running');
        pendingSubagentCards.splice(pendingIdx, 1);
      }

      const teamName = msg.teamName || null;
      const memberName = msg.memberName || null;

      activeSubagents.set(msg.agentId, {
        status: 'running',
        startTime: msg.timestamp,
        description: memberName || msg.description || info.description || msg.agentId.substring(0, 8),
        agentType: msg.agentType || info.type || 'general',
        teamName,
        memberName,
        currentTool: null,
        inputTokens: 0,
        outputTokens: 0,
        lastActivity: Date.now(),
        cardElement: matchedCard
      });

      // Track active team name from first teammate
      if (teamName && !activeTeamName) {
        activeTeamName = teamName;
      }
      pendingSubagentInfo = null;
      updateSubagentIndicator();
      break;
    }

    case 'subagent_output':
      handleSubagentOutput(msg.agentId, msg.data);
      break;

    case 'subagent_tool':
      if (activeSubagents.has(msg.agentId)) {
        const agent = activeSubagents.get(msg.agentId);
        agent.currentTool = msg.tool;
        agent.lastActivity = Date.now();
        updateSubagentIndicator();
        // Update inline activity card
        if (agent.cardElement) {
          updateSubagentCardTool(agent.cardElement, msg.tool);
        }
      }
      break;

    case 'subagent_tokens':
      if (activeSubagents.has(msg.agentId)) {
        const agent = activeSubagents.get(msg.agentId);
        agent.inputTokens = (agent.inputTokens || 0) + (msg.input || 0);
        agent.outputTokens = (agent.outputTokens || 0) + (msg.output || 0);
        updateSubagentIndicator();
      }
      break;

    case 'subagent_stop': {
      const stoppedAgent = activeSubagents.get(msg.agentId);
      if (stoppedAgent?.cardElement) {
        updateSubagentCardStatus(stoppedAgent.cardElement, 'completed');
      }
      activeSubagents.delete(msg.agentId);
      updateSubagentIndicator();
      break;
    }

    case 'team_message':
      // Inter-teammate message: { sender, recipient, content, type, timestamp }
      teamMessages.push({
        sender: msg.sender || 'unknown',
        recipient: msg.recipient || null,
        content: msg.content || '',
        msgType: msg.msgType || 'message',
        timestamp: msg.timestamp || new Date().toISOString()
      });
      // Cap at MAX_TEAM_MESSAGES
      while (teamMessages.length > MAX_TEAM_MESSAGES) {
        teamMessages.shift();
      }
      break;

    case 'claude_state':
      // Sync team state from server snapshot
      if (msg.state) {
        // Sync subagent team metadata
        if (msg.state.subagents) {
          for (const [id, info] of Object.entries(msg.state.subagents)) {
            const existing = activeSubagents.get(id);
            if (existing && info.teamName) {
              existing.teamName = info.teamName;
              existing.memberName = info.memberName;
            }
          }
        }
        // Sync team data
        if (msg.state.team) {
          activeTeamName = msg.state.team.name || null;
          // Sync recent team messages
          if (msg.state.team.recentMessages) {
            // Only add messages we don't already have (by timestamp)
            const existingTimestamps = new Set(teamMessages.map(m => m.timestamp));
            for (const m of msg.state.team.recentMessages) {
              if (!existingTimestamps.has(m.timestamp)) {
                teamMessages.push(m);
              }
            }
            while (teamMessages.length > MAX_TEAM_MESSAGES) {
              teamMessages.shift();
            }
          }
        } else {
          activeTeamName = null;
        }
        updateSubagentIndicator();
      }
      break;

    case 'inject_result':
      if (pendingInjectResolve) {
        pendingInjectResolve(msg.success);
      } else if (!msg.success) {
        showToast('Failed to send', 'error');
      }
      break;

    case 'error':
      showToast(msg.message, 'error');
      break;

    case 'commands':
      // Server-provided slash commands (matches iOS: entirely server-driven)
      if (Array.isArray(msg.data)) {
        slashCommands = msg.data.map(c => ({
          cmd: '/' + c.name,
          desc: c.description || ''
        }));
      }
      break;

    case 'mode_change':
      currentMode = msg.mode || 'default';
      updateModeIndicator();
      break;

    case 'pong':
      if (pingTimeout) clearTimeout(pingTimeout);
      break;
  }
}
