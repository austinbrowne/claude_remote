// ============================================
// Session Management
// ============================================
function updateSessionList(sessions) {
  const selector = document.getElementById('sessionSelector');
  const currentValue = selector.value;
  selector.innerHTML = '<option value="">Select session...</option>';

  sessions.forEach(session => {
    const option = document.createElement('option');
    option.value = session.id;
    option.dataset.status = session.status;
    option.dataset.branch = session.branch || '';
    const icon = session.status === 'waiting' ? '🟠 ' :
                 session.status === 'processing' ? '🔵 ' : '';
    const branchSuffix = session.branch ? ` (${session.branch})` : '';
    option.textContent = icon + session.name + branchSuffix;
    selector.appendChild(option);
  });

  // Restore selection if still exists
  if (currentValue && sessions.find(s => s.id === currentValue)) {
    selector.value = currentValue;
  } else if (sessions.length === 1) {
    selector.value = sessions[0].id;
    switchSession();
  }

  // Update mobile UI
  updateSessionDrawer(sessions);
  updateSessionLabel();
  updateSplashScreen(sessions);
}

function updateSessionStatus(sessionId, status) {
  const selector = document.getElementById('sessionSelector');
  const option = selector.querySelector(`option[value="${sessionId}"]`);
  if (!option) return;

  const icon = status === 'waiting' ? '🟠 ' :
               status === 'processing' ? '🔵 ' : '';
  const name = option.textContent.replace(/^(?:🟠|🔵)\s*/g, '');  // Strip old icon(s)
  option.textContent = icon + name;
  option.dataset.status = status;

  // Update drawer status dot
  const drawerRow = document.querySelector(`#sessionDrawerList .session-drawer-row[data-session-id="${CSS.escape(sessionId)}"]`);
  if (drawerRow) {
    const dot = drawerRow.querySelector('.session-status-dot');
    if (dot) dot.className = 'session-status-dot ' + (status || '');
  }

  // Update header label dot if this is the current session
  if (sessionId === currentSessionId) {
    updateSessionLabel();
    updateSessionStatusText(status);
    checkFallbackApproval();
  }
}

function switchSession() {
  const sessionId = document.getElementById('sessionSelector').value;
  if (!sessionId) return;

  hideFallbackApproval();

  // Set switching state to prevent race conditions with in-flight messages
  sessionState = SESSION_STATE.SWITCHING;
  pendingSessionId = sessionId;

  // Unwatch the old session so the server stops sending its output
  if (currentSessionId && currentSessionId !== sessionId) {
    wsSend({ action: 'unwatch_session', sessionId: currentSessionId });
  }

  // Update currentSessionId IMMEDIATELY so commands go to the right session
  // even before server confirms the watch
  currentSessionId = sessionId;

  document.getElementById('outputArea').innerHTML = '';

  // Reset session-specific state
  resetSessionTokens();
  clearTasks();
  activeSubagents.clear();
  activeTeamName = null;
  teamMessages.length = 0;
  milestones = [];
  renderMilestones();
  // Clear pending subagent card timeouts
  pendingSubagentCards.forEach(p => clearTimeout(p.timeout));
  pendingSubagentCards.length = 0;
  updateSubagentIndicator();
  currentMode = 'default';
  updateModeIndicator();
  document.getElementById('statusBar')?.classList.add('hidden');
  // Clear buffered output messages from the previous session
  pendingOutputMessages.length = 0;
  pendingPromptMessage = null;
  // Clear prompt state from previous session (#43)
  promptQueue.length = 0;
  hidePromptCard();
  if (pending.permissionTimeout) {
    clearTimeout(pending.permissionTimeout);
    pending.permissionTimeout = null;
  }
  pending.permissionCard = null;
  pendingSubagentPermissions.forEach(p => clearTimeout(p.timeout));
  pendingSubagentPermissions.clear();

  wsSend({ action: 'watch_session', sessionId: sessionId });

  // Show doc viewer button when session is active
  const docBtn = document.getElementById('docViewerBtn');
  if (docBtn) docBtn.style.display = sessionId ? '' : 'none';

  // Update header label and hide splash
  updateSessionLabel();
  document.getElementById('sessionPickerSplash')?.classList.add('hidden');
}

function updateSessionLabel() {
  const selector = document.getElementById('sessionSelector');
  const option = selector.selectedOptions[0];
  const labelName = document.getElementById('sessionLabelName');
  const labelDot = document.getElementById('sessionLabelDot');
  if (!labelName || !option || !option.value) {
    if (labelName) labelName.textContent = 'No session';
    if (labelDot) labelDot.className = 'session-label-dot';
    return;
  }
  // Strip emoji prefix and branch suffix for clean display — just the repo name
  let name = option.textContent.replace(/^(?:🟠|🔵)\s*/g, '');
  name = name.replace(/\s*\(.*\)$/, '');
  labelName.textContent = name;
  labelDot.className = 'session-label-dot ' + (option.dataset.status || '');
}

function updateSplashScreen(sessions) {
  const splash = document.getElementById('sessionPickerSplash');
  const list = document.getElementById('splashSessionList');
  if (!splash || !list) return;

  // Hide splash if a session is already selected or being reconnected
  if (currentSessionId || pending.reconnectSession) {
    splash.classList.add('hidden');
    return;
  }

  // Show splash on mobile only
  if (!isMobile()) {
    splash.classList.add('hidden');
    return;
  }

  splash.classList.remove('hidden');
  list.innerHTML = '';

  if (sessions.length === 0) {
    list.innerHTML = '<div class="splash-empty">No active sessions found</div>';
    return;
  }

  sessions.forEach(session => {
    const row = document.createElement('div');
    row.className = 'splash-row';

    const dot = document.createElement('span');
    dot.className = 'session-status-dot ' + (session.status || '');
    row.appendChild(dot);

    const name = document.createElement('span');
    name.className = 'session-name';
    name.textContent = session.name;
    row.appendChild(name);

    if (session.branch) {
      const branch = document.createElement('span');
      branch.className = 'session-branch';
      branch.textContent = session.branch;
      row.appendChild(branch);
    }

    row.addEventListener('click', () => {
      document.getElementById('sessionSelector').value = session.id;
      switchSession();
    });
    list.appendChild(row);
  });
}

function clearDisplay() {
  if (!currentSessionId) return;

  // Clear output and UI state
  document.getElementById('outputArea').innerHTML = '';
  hidePromptCard();
  clearTasks();
  activeSubagents.clear();
  activeTeamName = null;
  teamMessages.length = 0;
  updateSubagentIndicator();
  document.getElementById('statusBar')?.classList.add('hidden');

  // Re-watch the current session to get fresh history from the server
  wsSend({ action: 'unwatch_session', sessionId: currentSessionId });
  wsSend({ action: 'watch_session', sessionId: currentSessionId });
}

// ============================================
// Session Drawer (mobile swipe-to-open)
// ============================================

function openSessionDrawer() {
  const drawer = document.getElementById('sessionDrawer');
  const overlay = document.getElementById('sessionDrawerOverlay');
  drawer.style.transition = 'transform 0.3s ease';
  drawer.style.transform = 'translateX(0)';
  overlay.classList.add('show');
  drawerOpen = true;
  navigator.vibrate?.(10);
}

function closeSessionDrawer() {
  const drawer = document.getElementById('sessionDrawer');
  const overlay = document.getElementById('sessionDrawerOverlay');
  drawer.style.transition = 'transform 0.3s ease';
  drawer.style.transform = 'translateX(-100%)';
  overlay.classList.remove('show');
  drawerOpen = false;
  // Clear inline opacity left by gesture tracking
  overlay.style.opacity = '';
}

function updateSessionDrawer(sessions) {
  const list = document.getElementById('sessionDrawerList');
  if (!list) return;
  list.innerHTML = '';
  sessions.forEach(session => {
    const row = document.createElement('div');
    row.className = 'session-drawer-row' +
      (session.id === currentSessionId ? ' active' : '');
    row.dataset.sessionId = session.id;

    const dot = document.createElement('span');
    dot.className = 'session-status-dot ' + (session.status || '');
    row.appendChild(dot);

    const name = document.createElement('span');
    name.className = 'session-name';
    name.textContent = session.name;
    row.appendChild(name);

    if (session.branch) {
      const branch = document.createElement('span');
      branch.className = 'session-branch';
      branch.textContent = session.branch;
      row.appendChild(branch);
    }

    row.addEventListener('click', () => {
      document.getElementById('sessionSelector').value = session.id;
      switchSession();
      closeSessionDrawer();
    });
    list.appendChild(row);
  });
}

function setupSessionDrawerSwipe() {
  if (!isMobile()) return;

  let touchStartX = 0;
  let touchStartY = 0;
  let touchStartTime = 0;
  let isSwiping = false;

  const drawer = document.getElementById('sessionDrawer');
  const overlay = document.getElementById('sessionDrawerOverlay');

  let swipeDirection = null; // 'open' or 'close'

  document.body.addEventListener('touchstart', (e) => {
    const touch = e.touches[0];
    // Open gesture: swipe from left edge when closed
    if (!drawerOpen && touch.clientX < 30) {
      touchStartX = touch.clientX;
      touchStartY = touch.clientY;
      touchStartTime = Date.now();
      isSwiping = true;
      swipeDirection = 'open';
      drawer.style.transition = 'none';
      overlay.style.transition = 'none';
    }
    // Close gesture: swipe anywhere when open (drawer or overlay)
    else if (drawerOpen) {
      touchStartX = touch.clientX;
      touchStartY = touch.clientY;
      touchStartTime = Date.now();
      isSwiping = true;
      swipeDirection = 'close';
      drawer.style.transition = 'none';
      overlay.style.transition = 'none';
    }
  }, { passive: true });

  document.body.addEventListener('touchmove', (e) => {
    if (!isSwiping) return;
    const touch = e.touches[0];
    const dx = touch.clientX - touchStartX;
    const dy = Math.abs(touch.clientY - touchStartY);

    // Cancel if vertical movement dominates (only for open gesture)
    if (swipeDirection === 'open' && dy > Math.abs(dx) && dx < 10) {
      isSwiping = false;
      closeSessionDrawer();
      return;
    }

    if (swipeDirection === 'open') {
      const progress = Math.max(0, Math.min(dx / 280, 1));
      drawer.style.transform = `translateX(${-280 + (progress * 280)}px)`;
      overlay.style.opacity = String(progress * 0.4);
    } else {
      // Close: dx is negative (swiping left)
      const progress = Math.max(0, Math.min(1 + dx / 280, 1));
      drawer.style.transform = `translateX(${-280 + (progress * 280)}px)`;
      overlay.style.opacity = String(progress * 0.4);
    }
  }, { passive: true });

  document.body.addEventListener('touchend', (e) => {
    if (!isSwiping) return;
    isSwiping = false;

    const dx = e.changedTouches[0].clientX - touchStartX;
    const elapsed = Date.now() - touchStartTime;
    const velocity = dx / Math.max(elapsed, 1);

    drawer.style.transition = 'transform 0.3s ease';
    overlay.style.transition = 'opacity 0.3s ease';

    if (swipeDirection === 'open') {
      if (dx > 80 || velocity > 0.5) {
        openSessionDrawer();
      } else {
        closeSessionDrawer();
      }
    } else {
      // Close: negative dx = swiping left
      if (dx < -60 || velocity < -0.3) {
        closeSessionDrawer();
      } else {
        openSessionDrawer();
      }
    }
    swipeDirection = null;
  }, { passive: true });

  // Close on overlay tap
  overlay.addEventListener('click', () => {
    closeSessionDrawer();
  });
}

function refreshSessions() {
  wsSend({ action: 'refresh_sessions' });
  // Hard reset current session (like switching away and back)
  if (currentSessionId) {
    const savedSession = currentSessionId;
    // Reset state
    currentSessionId = null;
    sessionState = SESSION_STATE.IDLE;
    // Clear session-specific state
    resetSessionTokens();
    clearTasks();
    activeSubagents.clear();
    activeTeamName = null;
    teamMessages.length = 0;
    updateSubagentIndicator();
    document.getElementById('outputArea').innerHTML = '';
    document.getElementById('statusBar')?.classList.add('hidden');
    // Re-watch the session (will get fresh history and subagent state)
    currentSessionId = savedSession;
    sessionState = SESSION_STATE.SWITCHING;
    pendingSessionId = savedSession;
    wsSend({ action: 'watch_session', sessionId: savedSession });
  }
  showToast('Refreshing...', 'success');
}

// ============================================
// Tool Result Merging (matches iOS mergeOrAppendToolResult)
// ============================================
function mergeOrAppendToolResult(data) {
  const toolUseId = data.toolUseId;
  if (toolUseId) {
    const outputArea = document.getElementById('outputArea');
    // Find matching tool row in a batch
    const row = outputArea.querySelector(`.history-tool-row[data-tool-use-id="${CSS.escape(toolUseId)}"]`);
    if (row) {
      const isError = !!data.isError;

      // Update status icon
      const iconSpan = row.querySelector('.history-tool-icon');
      if (iconSpan) {
        iconSpan.style.color = isError ? 'var(--error)' : 'var(--success)';
        iconSpan.textContent = isError ? '✕' : '✓';
      }

      // Remove approve button
      const approveBtn = row.querySelector('.tool-approve-btn');
      if (approveBtn) approveBtn.remove();

      // Store result data for expand-on-click
      row._resultData = data;

      // Update expanded content if already open
      const expandEl = row.nextElementSibling;
      if (expandEl && expandEl.classList.contains('history-tool-expand')) {
        const fullResult = typeof data.content === 'string' ? data.content : JSON.stringify(data.content, null, 2);
        if (!expandEl.querySelector('.tool-result-section')) {
          const div = document.createElement('div');
          div.className = 'tool-result-section';
          div.style.cssText = 'border-top:1px solid var(--separator);margin-top:6px;padding-top:6px';
          div.innerHTML = `<pre>${escapeHtml(fullResult.substring(0, 2000))}</pre>`;
          expandEl.appendChild(div);
        }
      }

      // Update batch header
      const batch = row.closest('.history-tool-batch');
      if (batch) updateBatchHeader(batch);

      outputArea.scrollTop = outputArea.scrollHeight;
      return;
    }
  }

  // Fallback: standalone tool_result (no matching tool row found)
  appendMessage(data);
}

// ============================================
// Tool Grouping (matches iOS ToolGroupView)
// ============================================

// Render a batch of tool uses from history as a simple expandable summary.
// Uses a .message.assistant styled container so it participates in the same
// flex layout as other chat bubbles — avoids the .tool-group CSS issues.
function renderHistoryToolBatch(outputArea, batch) {
  const tools = batch.tools;
  const results = batch.results;
  if (tools.length === 0) return;

  // Build tool name counts for summary
  const toolCounts = {};
  tools.forEach(t => {
    const name = t.tool || 'Tool';
    toolCounts[name] = (toolCounts[name] || 0) + 1;
  });
  const summaryText = Object.entries(toolCounts)
    .map(([name, c]) => c > 1 ? `${name} ×${c}` : name)
    .join(', ');

  // Build status: check if each tool has a result
  const allComplete = tools.every(t => t.toolUseId && results.has(t.toolUseId));
  const hasErrors = tools.some(t => {
    const r = results.get(t.toolUseId);
    return r && r.isError;
  });

  // Create container styled as a chat element
  const container = document.createElement('div');
  container.className = 'history-tool-batch';

  // Header row (always visible)
  const header = document.createElement('div');
  header.className = 'history-tool-batch-header';
  // Per-tool status indicators (checkmarks/spinners matching iOS ToolGroupView)
  let statusHtml = '';
  tools.forEach(t => {
    const result = t.toolUseId ? results.get(t.toolUseId) : null;
    if (result) {
      const isError = result.isError;
      statusHtml += `<span class="tool-group-check ${isError ? 'error' : 'success'}">${isError ? '✕' : '✓'}</span>`;
    } else {
      statusHtml += '<span class="tool-group-spinner"></span>';
    }
  });
  header.innerHTML = `
    <svg class="tool-group-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="9 6 15 12 9 18"/></svg>
    <span style="font-size:13px">🔧</span>
    <span class="history-tool-batch-label">Used ${tools.length} tool${tools.length !== 1 ? 's' : ''}</span>
    <span class="history-tool-batch-summary">${escapeHtml(summaryText)}</span>
    <span class="history-tool-batch-status">${statusHtml}</span>
  `;
  container.appendChild(header);

  // Detail rows (hidden until expanded)
  const details = document.createElement('div');
  details.className = 'history-tool-batch-details';
  tools.forEach(t => {
    const toolSummary = getToolSummary(t.tool, t.input);
    const result = results.get(t.toolUseId);
    const resultPreview = result
      ? (typeof result.content === 'string' ? result.content : JSON.stringify(result.content))
        .split('\n')[0].substring(0, 60)
      : '';
    const icon = result ? (result.isError ? '<span style="color:var(--error)">✕</span>' : '<span style="color:var(--success)">✓</span>') : '<span style="color:var(--text-muted)">⋯</span>';

    const row = document.createElement('div');
    row.className = 'history-tool-row';
    row.innerHTML = `
      ${icon}
      <span class="history-tool-name">${escapeHtml(t.tool || 'Tool')}</span>
      <span class="history-tool-path">${escapeHtml(toolSummary)}</span>
    `;

    // Expand row to show full input/output on click
    if (t.input || result) {
      row.style.cursor = 'pointer';
      row.addEventListener('click', () => {
        let expandEl = row.nextElementSibling;
        if (expandEl && expandEl.classList.contains('history-tool-expand')) {
          expandEl.remove();
          return;
        }
        expandEl = document.createElement('div');
        expandEl.className = 'history-tool-expand';
        const fullInput = t.input == null ? '' : typeof t.input === 'string' ? t.input : JSON.stringify(t.input, null, 2);
        const fullResult = result ? (typeof result.content === 'string' ? result.content : JSON.stringify(result.content, null, 2)) : '';
        expandEl.innerHTML = `<pre>${escapeHtml(fullInput)}</pre>${fullResult ? `<div style="border-top:1px solid var(--separator);margin-top:6px;padding-top:6px"><pre>${escapeHtml(fullResult.substring(0, 2000))}</pre></div>` : ''}`;
        row.after(expandEl);
      });
    }

    details.appendChild(row);
  });
  container.appendChild(details);

  // Toggle expand on header click
  header.addEventListener('click', () => {
    container.classList.toggle('expanded');
  });

  outputArea.appendChild(container);
}

// Get or create a live tool batch (reuse last child if it's a batch)
function getOrCreateToolBatch(outputArea) {
  const lastChild = outputArea.lastElementChild;
  if (lastChild && lastChild.classList.contains('history-tool-batch')) {
    return lastChild;
  }
  const container = document.createElement('div');
  container.className = 'history-tool-batch';

  const header = document.createElement('div');
  header.className = 'history-tool-batch-header';
  header.innerHTML = `
    <svg class="tool-group-chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="9 6 15 12 9 18"/></svg>
    <span style="font-size:13px">🔧</span>
    <span class="history-tool-batch-label">Working...</span>
    <span class="history-tool-batch-summary"></span>
    <span class="history-tool-batch-status"></span>
  `;
  header.addEventListener('click', () => container.classList.toggle('expanded'));
  container.appendChild(header);

  const details = document.createElement('div');
  details.className = 'history-tool-batch-details';
  container.appendChild(details);

  outputArea.appendChild(container);
  return container;
}

// Add a single tool to a live batch (incremental — called per tool message)
function addToolToBatch(batch, data) {
  const details = batch.querySelector('.history-tool-batch-details');
  const toolSummary = getToolSummary(data.tool, data.input);

  const row = document.createElement('div');
  row.className = 'history-tool-row';
  if (data.toolUseId) row.dataset.toolUseId = data.toolUseId;

  const approveBtn = data.needsApproval && data.toolUseId
    ? `<button class="tool-approve-btn" title="Approve">✓</button>`
    : '';

  row.innerHTML = `
    <span class="history-tool-icon" style="color:var(--text-muted)">⋯</span>
    <span class="history-tool-name">${escapeHtml(data.tool || 'Tool')}</span>
    <span class="history-tool-path">${escapeHtml(toolSummary)}</span>
    ${approveBtn}
  `;

  // Store tool data for expand-on-click
  row._toolData = data;
  row.style.cursor = 'pointer';
  row.addEventListener('click', (e) => {
    if (e.target.closest('.tool-approve-btn')) return;
    let expandEl = row.nextElementSibling;
    if (expandEl && expandEl.classList.contains('history-tool-expand')) {
      expandEl.remove();
      return;
    }
    expandEl = document.createElement('div');
    expandEl.className = 'history-tool-expand';
    const fullInput = data.input == null ? '' : typeof data.input === 'string' ? data.input : JSON.stringify(data.input, null, 2);
    const resultData = row._resultData;
    const fullResult = resultData ? (typeof resultData.content === 'string' ? resultData.content : JSON.stringify(resultData.content, null, 2)) : '';
    expandEl.innerHTML = `<pre>${escapeHtml(fullInput)}</pre>${fullResult ? `<div style="border-top:1px solid var(--separator);margin-top:6px;padding-top:6px"><pre>${escapeHtml(fullResult.substring(0, 2000))}</pre></div>` : ''}`;
    row.after(expandEl);
  });

  // Approve button handler
  if (data.needsApproval && data.toolUseId) {
    const btn = row.querySelector('.tool-approve-btn');
    if (btn) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        manualApproveToolUse(data.toolUseId);
      });
    }
  }

  details.appendChild(row);
  updateBatchHeader(batch);
  return row;
}

// Update batch header with current tool counts and status
function updateBatchHeader(batch) {
  const rows = batch.querySelectorAll('.history-tool-batch-details > .history-tool-row');
  const toolCounts = {};
  let statusHtml = '';

  rows.forEach(row => {
    const name = row.querySelector('.history-tool-name')?.textContent || 'Tool';
    toolCounts[name] = (toolCounts[name] || 0) + 1;

    if (row._resultData) {
      const isError = row._resultData.isError;
      statusHtml += `<span class="tool-group-check ${isError ? 'error' : 'success'}">${isError ? '✕' : '✓'}</span>`;
    } else {
      statusHtml += '<span class="tool-group-spinner"></span>';
    }
  });

  const count = rows.length;
  batch.querySelector('.history-tool-batch-label').textContent = count > 0
    ? `Used ${count} tool${count !== 1 ? 's' : ''}`
    : 'Working...';
  batch.querySelector('.history-tool-batch-summary').textContent = Object.entries(toolCounts)
    .map(([name, c]) => c > 1 ? `${name} ×${c}` : name)
    .join(', ');
  batch.querySelector('.history-tool-batch-status').innerHTML = statusHtml;
}

// ============================================
// Output Rendering
// ============================================
function renderHistory(history) {
  const outputArea = document.getElementById('outputArea');
  outputArea.innerHTML = '';
  promptQueue.length = 0; // Clear any queued prompts
  hidePromptCard(); // Clear any existing prompt

  // Group consecutive tool + tool_result entries into batches for summary rendering.
  // This avoids the CSS tool-group wrapper which has layout issues on mobile Safari.
  const batches = [];
  let currentToolBatch = null;

  history.forEach(entry => {
    // Skip transient types
    if (entry.type === 'status_update') return;
    if (entry.type === 'compaction_starting' || entry.type === 'compaction_complete') return;
    if (entry.type === 'subagent_starting') return;

    if (entry.type === 'tool' || entry.type === 'tool_result') {
      if (!currentToolBatch) {
        currentToolBatch = { type: 'tool_batch', tools: [], results: new Map() };
        batches.push(currentToolBatch);
      }
      if (entry.type === 'tool') {
        currentToolBatch.tools.push(entry);
      } else {
        // Map result to its tool by toolUseId
        if (entry.toolUseId) {
          currentToolBatch.results.set(entry.toolUseId, entry);
        }
      }
    } else {
      // Non-tool entry: flush any pending tool batch
      currentToolBatch = null;
      batches.push(entry);
    }
  });

  // Render batches
  batches.forEach(batch => {
    if (batch.type === 'tool_batch') {
      renderHistoryToolBatch(outputArea, batch);
    } else {
      appendMessage(batch, false, true); // skipPromptDetection=true
    }
  });

  outputArea.scrollTop = outputArea.scrollHeight;

  // Check if history contains an unanswered prompt (permission or question)
  if (history.length > 0) {
    // Find index of last prompt-like message
    let lastPromptIndex = -1;
    for (let i = history.length - 1; i >= 0; i--) {
      const entry = history[i];
      if (entry.type === 'ask_user_question' || entry.type === 'permission_request' || entry.type === 'exit_plan_mode') {
        lastPromptIndex = i;
        break;
      }
    }

    // Check if there's a user message after the last prompt (meaning it's answered)
    let hasUserResponseAfterPrompt = false;
    if (lastPromptIndex >= 0) {
      for (let i = lastPromptIndex + 1; i < history.length; i++) {
        if (history[i].type === 'user') {
          hasUserResponseAfterPrompt = true;
          break;
        }
      }
    }

    // Only show prompt if unanswered
    if (!hasUserResponseAfterPrompt && lastPromptIndex >= 0) {
      const promptEntry = history[lastPromptIndex];
      if (promptEntry.type === 'exit_plan_mode') {
        showPlanExitPrompt();
      } else if (promptEntry.type === 'ask_user_question' && promptEntry.questions) {
        showStructuredPrompt(promptEntry.questions);
      } else if (promptEntry.type === 'permission_request') {
        // Only show if session is waiting (not already executing)
        const sessionOption = document.querySelector(`#sessionSelector option[value="${currentSessionId}"]`);
        if (sessionOption?.dataset.status === 'waiting') {
          const input = promptEntry.input || {};
          const tool = promptEntry.tool;
          const isDestructive = tool === 'Bash' && /\brm\b|\bdelete\b|\bdrop\b/.test((input.command || '').toLowerCase());
          pending.lastPermissionCardTime = Date.now();
          showPromptCard({ type: 'permission', text: `Allow ${tool}?`, command: input, tool: tool, isDestructive, toolUseId: promptEntry.toolUseId || null });
        }
      }
    }
  }
}

// Types that are chat-visible (everything else is transient/structural)
const CHAT_TYPES = new Set(['assistant', 'user', 'tool', 'tool_result']);

function appendMessage(data, scroll = true, skipPromptDetection = false, subagentId = null) {
  // Only render actual chat content — skip transient/structural types
  if (!CHAT_TYPES.has(data.type)) return;
  // Skip empty assistant messages (no content)
  if (data.type === 'assistant' && (!data.content || !data.content.trim())) return;

  const outputArea = document.getElementById('outputArea');
  document.getElementById('emptyState')?.remove();

  // Check for staleness of existing prompt
  if (!skipPromptDetection) checkPromptStaleness();

  // Remove oldest messages if over limit
  while (outputArea.children.length >= MAX_MESSAGES) {
    outputArea.removeChild(outputArea.firstChild);
  }

  const msg = document.createElement('div');
  const isSubagent = !!subagentId;
  msg.className = `message ${data.type}${isSubagent ? ' subagent' : ''}`;
  // Debug: show when subagent class is applied
  if (debugMode && isSubagent) {
    showToast(`CLASS: ${msg.className}`, 'success');
  }

  // Store toolUseId for tool card merging (matches iOS)
  if (data.toolUseId && (data.type === 'tool' || data.type === 'permission_request')) {
    msg.dataset.toolUseId = data.toolUseId;
  }

  if (data.type === 'tool') {
    // Use the same batch rendering as history — add tool to a batch group
    const batch = getOrCreateToolBatch(outputArea);
    addToolToBatch(batch, data);
    if (scroll) outputArea.scrollTop = outputArea.scrollHeight;
    return msg;
  } else if (data.type === 'tool_result') {
    const result = typeof data.content === 'string' ? data.content : JSON.stringify(data.content, null, 2);
    const lines = result.split('\n');
    const preview = lines[0].substring(0, 50);
    const lineCount = lines.length;
    const needsEllipsis = lines[0].length > 50 || lineCount > 1;
    const lang = pending.lastToolLanguage || 'plaintext';
    msg.innerHTML = `
      <div class="tool-summary" data-lang="${escapeHtml(lang)}">
        <span class="tool-chevron">▶</span>
        <span style="color: var(--text-muted)">Result: ${escapeHtml(preview)}${needsEllipsis ? '...' : ''} (${lineCount} lines)</span>
      </div>
      <div class="tool-details"><pre>${escapeHtml(result)}</pre></div>
    `;
  } else if (data.type === 'assistant') {
    const content = typeof data.content === 'string'
      ? data.content
      : JSON.stringify(data.content);
    const prefix = isSubagent ? '<span style="color: var(--orange); font-weight: 600;">🤖 </span>' : '';
    const rendered = renderAssistantContent(content);
    msg.innerHTML = prefix + `<div class="markdown-body">${rendered}</div>`;
  } else {
    const content = typeof data.content === 'string'
      ? data.content
      : JSON.stringify(data.content);
    // Add visual prefix for subagent messages
    const prefix = isSubagent ? '<span style="color: var(--orange); font-weight: 600;">🤖 </span>' : '';
    msg.innerHTML = `<pre>${prefix}${escapeHtml(content)}</pre>`;
  }

  outputArea.appendChild(msg);

  if (scroll) {
    outputArea.scrollTop = outputArea.scrollHeight;
  }

  return msg;
}

function formatToolInput(input) {
  if (typeof input === 'string') return input;
  if (input.command) return input.command;
  if (input.content) return input.content.substring(0, 200) + (input.content.length > 200 ? '...' : '');
  if (input.path) return input.path;
  return JSON.stringify(input, null, 2).substring(0, 200);
}

// Clean summary for tool cards (matches iOS ToolCardView summaries)
function getToolSummary(tool, input) {
  if (!input) return '';
  switch (tool) {
    case 'Read': case 'Write': case 'Edit': case 'MultiEdit':
      return (input.file_path || '').split('/').pop() || '';
    case 'Bash':
      return (input.command || '').split('\n')[0].substring(0, 60);
    case 'Glob':
      return input.pattern || '';
    case 'Grep':
      return input.pattern || '';
    case 'WebFetch':
      return input.url || '';
    case 'WebSearch':
      return input.query || '';
    case 'Task':
      return (input.description || '').substring(0, 60);
    default:
      return '';
  }
}

// Toggle tool expand with syntax highlighting
function toggleToolExpand(element, language) {
  const wasExpanded = element.classList.contains('expanded');
  element.classList.toggle('expanded');

  // Apply syntax highlighting on first expand
  if (!wasExpanded && language && language !== 'plaintext') {
    const pre = element.querySelector('.tool-details pre');
    if (pre && !pre.classList.contains('highlighted')) {
      loadPrism().then(() => {
        highlightCode(pre, language);
        pre.classList.add('highlighted');
      });
    }
  }

  // Track language for tool_result pairing
  pending.lastToolLanguage = language;
}

// ============================================
// Diff Functions (LCS Algorithm)
// ============================================

/**
 * Compute diff between two strings using LCS (Longest Common Subsequence)
 * Returns array of {type: 'context'|'add'|'remove', line: string, oldNum?: number, newNum?: number}
 */
function computeDiff(oldStr, newStr) {
  const oldLines = (oldStr || '').split('\n');
  const newLines = (newStr || '').split('\n');

  // Build LCS table
  const m = oldLines.length;
  const n = newLines.length;
  const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to build diff
  const diff = [];
  let i = m, j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      diff.unshift({ type: 'context', line: oldLines[i - 1], oldNum: i, newNum: j });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      diff.unshift({ type: 'add', line: newLines[j - 1], newNum: j });
      j--;
    } else {
      diff.unshift({ type: 'remove', line: oldLines[i - 1], oldNum: i });
      i--;
    }
  }

  return diff;
}

/**
 * Render diff as HTML with line numbers
 * Shows max lines with context around changes
 */
function renderDiff(oldStr, newStr, maxLines = 20) {
  if (!oldStr && !newStr) return '';

  const diff = computeDiff(oldStr, newStr);

  // Find changed regions and include context
  const contextLines = 2;
  const changedIndices = new Set();

  diff.forEach((d, i) => {
    if (d.type !== 'context') {
      for (let j = Math.max(0, i - contextLines); j <= Math.min(diff.length - 1, i + contextLines); j++) {
        changedIndices.add(j);
      }
    }
  });

  // Build output with limited lines
  let html = '<div class="diff-preview">';
  let shown = 0;
  let skipped = 0;

  diff.forEach((d, i) => {
    if (!changedIndices.has(i)) {
      skipped++;
      return;
    }

    if (shown >= maxLines) {
      return;
    }

    if (skipped > 0 && shown > 0) {
      html += `<div class="diff-truncated">... ${skipped} unchanged lines ...</div>`;
      skipped = 0;
    }

    const prefix = d.type === 'add' ? '+' : d.type === 'remove' ? '-' : ' ';
    const lineNum = d.type === 'remove' ? d.oldNum : d.newNum;

    html += `<div class="diff-line ${d.type}">`;
    html += `<span class="diff-line-number">${lineNum || ''}</span>`;
    html += `${prefix} ${escapeHtml(d.line)}`;
    html += '</div>';

    shown++;
  });

  if (shown >= maxLines && diff.length > shown) {
    html += `<div class="diff-truncated">... ${diff.length - shown} more lines ...</div>`;
  }

  html += '</div>';
  return html;
}

// ============================================
// Syntax Highlighting (Prism.js)
// ============================================
let prismLoaded = false;

// SRI hashes for Prism.js CDN resources (security)
const PRISM_SRI = {
  core: 'sha512-5BmBkPa0dCoqHc1APXLQjZhyRw6sl0RQDF1LvvqNGprNGOt8YLhTwP/RaG/mHDfSPMC7f7O+GQGHJLw+b+Kw6A==',
  // Language components use CDN versioning for integrity
};

function loadPrism() {
  if (prismLoaded) return Promise.resolve();
  return new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/prism.min.js';
    script.integrity = PRISM_SRI.core;
    script.crossOrigin = 'anonymous';
    script.onload = () => {
      // Load common language components
      const languages = ['javascript', 'typescript', 'python', 'bash', 'json', 'ruby', 'css', 'markup'];
      let loaded = 0;
      languages.forEach(lang => {
        const langScript = document.createElement('script');
        langScript.src = `https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-${lang}.min.js`;
        langScript.crossOrigin = 'anonymous';
        langScript.onload = () => { if (++loaded === languages.length) { prismLoaded = true; resolve(); } };
        langScript.onerror = () => { if (++loaded === languages.length) { prismLoaded = true; resolve(); } };
        document.head.appendChild(langScript);
      });
    };
    script.onerror = resolve; // Graceful fallback if CDN fails
    document.head.appendChild(script);
  });
}

function detectLanguage(toolInput) {
  if (!toolInput) return 'plaintext';
  const filePath = toolInput.file_path || toolInput.path || '';
  const ext = filePath.split('.').pop()?.toLowerCase();
  const map = {
    js: 'javascript', jsx: 'javascript', mjs: 'javascript',
    ts: 'typescript', tsx: 'typescript',
    py: 'python',
    rb: 'ruby',
    sh: 'bash', bash: 'bash', zsh: 'bash',
    json: 'json',
    css: 'css', scss: 'css',
    html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup',
    md: 'markdown'
  };
  return map[ext] || 'plaintext';
}

function highlightCode(preElement, language) {
  if (!prismLoaded || !window.Prism) return;
  const code = preElement.textContent;
  const lines = code.split('\n').length;
  // Skip highlighting for very large outputs (performance)
  if (lines > 500) return;

  try {
    const grammar = Prism.languages[language] || Prism.languages.plaintext;
    if (grammar) {
      preElement.innerHTML = Prism.highlight(code, grammar, language);
      preElement.classList.add(`language-${language}`);
    }
  } catch (e) {
    // Silently fail - plain text is fine
  }
}
