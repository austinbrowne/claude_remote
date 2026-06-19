// ============================================
// Markdown Rendering
// ============================================

// DOMPurify config: explicit allowlist (Finding #15)
const PURIFY_CONFIG = {
  ALLOWED_TAGS: ['p', 'br', 'strong', 'em', 'code', 'pre', 'h1', 'h2', 'h3', 'h4',
    'ul', 'ol', 'li', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'blockquote', 'hr', 'del', 'img', 'span', 'div', 'sup', 'sub'],
  ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'id'],
  FORBID_ATTR: ['style', 'onerror', 'onload', 'onclick'],
  ALLOW_DATA_ATTR: false,
  ADD_ATTR: ['target'],
};

// Block javascript: URIs
if (window.DOMPurify) {
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.hasAttribute('href')) {
      const val = node.getAttribute('href');
      if (val && /^\s*javascript:/i.test(val)) {
        node.removeAttribute('href');
      }
    }
    // External links open in new tab
    if (node.tagName === 'A' && node.getAttribute('href')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

function renderAssistantContent(content) {
  const markedReady = window.marked && typeof window.marked.parse === 'function';
  const purifyReady = window.DOMPurify && typeof window.DOMPurify.sanitize === 'function';

  if (markedReady && purifyReady) {
    return DOMPurify.sanitize(marked.parse(content, { breaks: true }), PURIFY_CONFIG);
  }
  // Fallback: safe plain text
  return '<pre>' + escapeHtml(content) + '</pre>';
}

// ============================================
// Command Sending
// ============================================
function sendCommand() {
  const input = document.getElementById('commandInput');
  const sendBtn = document.getElementById('sendBtn');
  const command = input.value.trim();

  // Empty input + pending permission = quick approve (send "1" for allow once)
  // Guard: never quick-approve destructive permissions (e.g. rm -rf, git push --force)
  if (!command && currentPrompt?.type === 'permission' && !currentPrompt.isDestructive) {
    respondToPrompt('y');
    return;
  }

  if (!command || sendBtn.disabled) return;

  // Prevent sending the exact same command within 10 seconds (stale replay protection)
  const now = Date.now();
  if (command === lastSentCommand.text && (now - lastSentCommand.timestamp) < 10000) {
    console.log('[SendCommand] Blocked duplicate send of:', command);
    showToast('Already sent', 'error');
    input.value = '';
    autoResize(input);
    return;
  }

  sendBtn.disabled = true;

  if (!wsSend({ action: 'inject', command: command, sessionId: currentSessionId })) {
    sendBtn.disabled = false;
    return;
  }

  // Track this as the last sent command
  lastSentCommand = { text: command, timestamp: now };

  trackSentMessage(command);
  appendMessage({ type: 'user', content: command });

  input.value = '';
  autoResize(input);
  showToast('Sent!', 'success');

  // Re-enable after a short delay to prevent accidental double-sends
  setTimeout(() => sendBtn.disabled = false, 300);
}

function sendPreset(cmd) {
  wsSend({ action: 'inject', command: cmd, sessionId: currentSessionId });
  trackSentMessage(cmd);
  appendMessage({ type: 'user', content: cmd });
  showToast('Sent!', 'success');
}

function sendEscape() {
  wsSend({ action: 'escape', sessionId: currentSessionId });
  showToast('Cancelled', 'success');
}

function sendModeToggle() {
  wsSend({ action: 'mode_toggle', sessionId: currentSessionId });
  showToast('Toggling mode...', 'success');
}

// Action Sheet
function showActionSheet() {
  document.getElementById('actionSheetOverlay').classList.add('show');
  document.getElementById('actionSheet').classList.add('show');
}

function hideActionSheet() {
  document.getElementById('actionSheetOverlay').classList.remove('show');
  document.getElementById('actionSheet').classList.remove('show');
}

function showSubagentSheet() {
  // Populate the list
  const list = document.getElementById('subagentSheetList');
  list.innerHTML = '';

  // Update sheet title if team is active
  const sheetTitle = document.querySelector('#subagentSheet .subagent-sheet-title');
  if (sheetTitle) {
    sheetTitle.textContent = activeTeamName ? `Team: ${activeTeamName}` : 'Active Agents';
  }

  if (activeSubagents.size === 0) {
    list.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--text-muted);">No active subagents</div>';
  } else {
    // Separate teammates from regular subagents
    const teammates = [];
    const regularAgents = [];
    activeSubagents.forEach((agent, id) => {
      if (agent.teamName) {
        teammates.push({ agent, id });
      } else {
        regularAgents.push({ agent, id });
      }
    });

    // Render teammates first (if any)
    if (teammates.length > 0) {
      for (const { agent, id } of teammates) {
        const statusClass = agent.status === 'waiting' ? 'waiting' :
                            agent.status === 'complete' ? 'complete' : 'running';
        const toolText = agent.currentTool || 'idle';
        const tokens = `${formatTokens(agent.inputTokens || 0)} in / ${formatTokens(agent.outputTokens || 0)} out`;
        const displayName = agent.memberName || agent.description || id.substring(0, 8);

        // Cross-reference tasks to find task ownership
        let ownedTask = null;
        tasks.forEach((task) => {
          if (task.owner === agent.memberName && task.status !== 'completed') {
            ownedTask = task;
          }
        });

        const item = document.createElement('div');
        item.className = 'subagent-sheet-item teammate';
        item.innerHTML = `
          <div class="subagent-sheet-item-header">
            <span class="subagent-sheet-status ${statusClass}"></span>
            <span class="subagent-sheet-name">${escapeHtml(displayName)}</span>
          </div>
          ${ownedTask ? `<div class="subagent-sheet-task">${escapeHtml(ownedTask.subject || '')}</div>` : ''}
          <div class="subagent-sheet-meta">
            <span class="subagent-sheet-tool">${escapeHtml(toolText)}</span>
            <span>${tokens}</span>
          </div>
        `;
        list.appendChild(item);
      }
    }

    // Render regular subagents
    if (regularAgents.length > 0) {
      if (teammates.length > 0) {
        // Add separator between teammates and regular subagents
        const separator = document.createElement('div');
        separator.className = 'subagent-sheet-separator';
        separator.textContent = 'Other Agents';
        list.appendChild(separator);
      }
      for (const { agent, id } of regularAgents) {
        const statusClass = agent.status === 'waiting' ? 'waiting' :
                            agent.status === 'complete' ? 'complete' : 'running';
        const toolText = agent.currentTool || 'idle';
        const tokens = `${formatTokens(agent.inputTokens || 0)} in / ${formatTokens(agent.outputTokens || 0)} out`;

        const item = document.createElement('div');
        item.className = 'subagent-sheet-item';
        item.innerHTML = `
          <div class="subagent-sheet-item-header">
            <span class="subagent-sheet-status ${statusClass}"></span>
            <span class="subagent-sheet-name">${escapeHtml(agent.description || id.substring(0, 8))}</span>
          </div>
          <div class="subagent-sheet-meta">
            <span class="subagent-sheet-tool">${escapeHtml(toolText)}</span>
            <span>${tokens}</span>
          </div>
        `;
        list.appendChild(item);
      }
    }
  }

  document.getElementById('subagentSheetOverlay').classList.add('show');
  document.getElementById('subagentSheet').classList.add('show');
}

function hideSubagentSheet() {
  document.getElementById('subagentSheetOverlay').classList.remove('show');
  document.getElementById('subagentSheet').classList.remove('show');
}

function handleKeyDown(event) {
  const autocomplete = document.getElementById('autocomplete');
  const isVisible = autocomplete.classList.contains('show');

  if (isVisible) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      navigateAutocomplete(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
      const selected = autocomplete.querySelector('.selected');
      if (selected) {
        event.preventDefault();
        selectAutocomplete(selected.dataset.cmd);
        return;
      }
    }
    if (event.key === 'Escape') {
      hideAutocomplete();
      return;
    }
  }

  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendCommand();
  }
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

// ============================================
// Command Autocomplete (server-driven, matches iOS)
// ============================================
let autocompleteIndex = -1;

// Show/hide the "Start Claude" button based on terminal session status
function updateStartClaudeButton(isTerminal) {
  const btn = document.getElementById('startClaudeBtn');
  if (!btn) return;
  if (isTerminal) {
    btn.classList.remove('hidden');
  } else {
    btn.classList.add('hidden');
  }
}

function startClaudeInTerminal() {
  const btn = document.getElementById('startClaudeBtn');
  if (!btn || btn.disabled || !currentSessionId) return;
  btn.disabled = true;
  btn.textContent = 'Starting Claude...';
  wsSend({ action: 'start_claude', sessionId: currentSessionId });
  // Reset after timeout
  setTimeout(() => {
    btn.disabled = false;
    btn.textContent = '▶ Start Claude Session';
  }, 12000);
}

function updateSendButtonState() {
  const input = document.getElementById('commandInput');
  const sendBtn = document.getElementById('sendBtn');
  if (!input || !sendBtn) return;
  const isEmpty = !input.value.trim();
  const hasPermission = currentPrompt?.type === 'permission';
  const isDestructive = currentPrompt?.isDestructive;
  if (isEmpty && hasPermission && !isDestructive) {
    sendBtn.classList.add('approve');
  } else {
    sendBtn.classList.remove('approve');
  }
}

function handleInput(el) {
  autoResize(el);
  updateSendButtonState();
  const value = el.value;

  if (value.startsWith('/') && slashCommands.length > 0) {
    const query = value.toLowerCase();
    const matches = slashCommands
      .filter(c => c.cmd.toLowerCase().includes(query))
      .slice(0, 6); // Max 6 suggestions (matches iOS)
    if (matches.length > 0) {
      showAutocomplete(matches);
    } else {
      hideAutocomplete();
    }
  } else {
    hideAutocomplete();
  }
}

function showAutocomplete(matches) {
  const autocomplete = document.getElementById('autocomplete');
  autocompleteIndex = -1;
  autocomplete.innerHTML = matches.map((m, i) => `
    <div class="autocomplete-item" data-cmd="${escapeHtml(m.cmd)}">
      <span class="cmd">${escapeHtml(m.cmd)}</span>
      <span class="desc">${escapeHtml(m.desc)}</span>
    </div>
  `).join('');
  autocomplete.classList.add('show');
}

function hideAutocomplete() {
  document.getElementById('autocomplete').classList.remove('show');
  autocompleteIndex = -1;
}

function navigateAutocomplete(direction) {
  const items = document.querySelectorAll('.autocomplete-item');
  if (items.length === 0) return;

  items.forEach(item => item.classList.remove('selected'));
  autocompleteIndex += direction;

  if (autocompleteIndex < 0) autocompleteIndex = items.length - 1;
  if (autocompleteIndex >= items.length) autocompleteIndex = 0;

  items[autocompleteIndex].classList.add('selected');
  items[autocompleteIndex].scrollIntoView({ block: 'nearest' });
}

function selectAutocomplete(cmd) {
  const input = document.getElementById('commandInput');
  input.value = cmd + ' ';
  input.focus();
  hideAutocomplete();
  autoResize(input);
}

// ============================================
// Text-to-Speech
// ============================================
function speak(text) {
  if (!settings.ttsEnabled || !synth) return;

  // Clear previous highlight explicitly (onend may not fire on cancel)
  if (speakingMessageElement) {
    speakingMessageElement.classList.remove('speaking');
    speakingMessageElement = null;
  }

  // Stop any current speech
  synth.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = settings.speechRate;

  // Find selected voice
  if (settings.voiceURI !== 'default') {
    const voices = synth.getVoices();
    const voice = voices.find(v => v.voiceURI === settings.voiceURI);
    if (voice) utterance.voice = voice;
  }

  // Highlight message being spoken
  const messages = document.querySelectorAll('.message.assistant');
  const lastMsg = messages[messages.length - 1];
  if (lastMsg) {
    lastMsg.classList.add('speaking');
    speakingMessageElement = lastMsg;
  }

  utterance.onend = () => {
    if (speakingMessageElement) {
      speakingMessageElement.classList.remove('speaking');
      speakingMessageElement = null;
    }
  };

  synth.speak(utterance);
  currentUtterance = utterance;
}

function toggleTTS() {
  settings.ttsEnabled = !settings.ttsEnabled;
  safeSetItem(localStorage, 'tts_enabled', settings.ttsEnabled);
  document.getElementById('ttsEnabled').checked = settings.ttsEnabled;
  updateTTSButton();

  if (!settings.ttsEnabled) {
    // Clear highlight explicitly since cancel may not fire onend
    if (speakingMessageElement) {
      speakingMessageElement.classList.remove('speaking');
      speakingMessageElement = null;
    }
    synth.cancel();
  }

  showToast(settings.ttsEnabled ? 'TTS enabled' : 'TTS disabled', 'success');
}

function updateTTSButton() {
  const btn = document.getElementById('ttsToggle');
  if (!btn) return;
  btn.innerHTML = settings.ttsEnabled
    ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07"/></svg>'
    : '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="22" y1="9" x2="16" y2="15"/><line x1="16" y1="9" x2="22" y2="15"/></svg>';
  btn.classList.toggle('active', settings.ttsEnabled);
}

// ============================================
// Voice Input
// ============================================
function toggleVoiceInput() {
  if (!recognition) {
    showToast('Voice input not supported', 'error');
    return;
  }

  // If trigger mode is active, disable it and switch to manual
  if (triggerState !== TRIGGER_STATE.IDLE) {
    disableTriggerMode();
  }

  if (isRecording) {
    try {
      recognition.stop();
    } catch (e) {
      console.error('Error stopping recognition:', e);
    }
    isRecording = false;
    document.getElementById('voiceBtn').classList.remove('recording');
  } else {
    try {
      recognition.start();
      isRecording = true;
      document.getElementById('voiceBtn').classList.add('recording');
    } catch (e) {
      console.error('Error starting recognition:', e);
      isRecording = false;
      document.getElementById('voiceBtn').classList.remove('recording');
      showToast('Microphone access denied', 'error');
    }
  }
}

// ============================================
// Trigger Word Mode
// ============================================
function toggleTriggerMode() {
  if (triggerState !== TRIGGER_STATE.IDLE) {
    disableTriggerMode();
  } else {
    enableTriggerMode();
  }
}

function enableTriggerMode() {
  if (!recognition) {
    showToast('Voice not supported', 'error');
    return;
  }

  // Stop any current manual recording
  if (isRecording) {
    try { recognition.stop(); } catch (e) {}
    isRecording = false;
  }

  triggerState = TRIGGER_STATE.LISTENING;
  settings.triggerEnabled = true;
  safeSetItem(localStorage, 'trigger_enabled', 'true');
  document.getElementById('triggerEnabled').checked = true;

  // Configure for trigger listening
  recognition.continuous = !isIOS;
  recognition.interimResults = true;

  try {
    recognition.start();
  } catch (e) {
    console.error('Error starting trigger listening:', e);
    triggerState = TRIGGER_STATE.IDLE;
    showToast('Mic access denied', 'error');
    return;
  }

  updateTriggerUI();
  showToast('Listening for "Titus"...', 'success');
}

function disableTriggerMode() {
  triggerState = TRIGGER_STATE.IDLE;
  triggerCommandBuffer = '';
  if (triggerSilenceTimer) {
    clearTimeout(triggerSilenceTimer);
    triggerSilenceTimer = null;
  }

  settings.triggerEnabled = false;
  safeSetItem(localStorage, 'trigger_enabled', 'false');
  document.getElementById('triggerEnabled').checked = false;

  try { recognition.stop(); } catch (e) {}
  isRecording = false;

  // Restore default recognition settings
  recognition.continuous = false;

  updateTriggerUI();
  showToast('Trigger mode off', 'success');
}

function startTriggerCapture(textAfterTrigger) {
  triggerState = TRIGGER_STATE.CAPTURING;
  triggerCommandBuffer = textAfterTrigger || '';
  navigator.vibrate?.(50);
  updateTriggerUI();

  // Show any initial text in the input
  if (triggerCommandBuffer) {
    const input = document.getElementById('commandInput');
    input.value = triggerCommandBuffer;
    autoResize(input);
  }

  // Start silence timer
  resetTriggerSilenceTimer();
}

function resetTriggerSilenceTimer() {
  if (triggerSilenceTimer) clearTimeout(triggerSilenceTimer);
  triggerSilenceTimer = setTimeout(() => finalizeTriggerCommand(), TRIGGER_SILENCE_MS);
}

function finalizeTriggerCommand() {
  if (triggerSilenceTimer) {
    clearTimeout(triggerSilenceTimer);
    triggerSilenceTimer = null;
  }

  const command = triggerCommandBuffer.trim();
  triggerCommandBuffer = '';
  triggerState = TRIGGER_STATE.IDLE;

  // Stop recognition completely - go fully idle
  try { recognition.stop(); } catch (e) {}
  isRecording = false;

  if (command) {
    // Try to send the command
    const input = document.getElementById('commandInput');
    input.value = command;
    autoResize(input);

    const success = wsSend({ action: 'inject', command, sessionId: currentSessionId });
    if (success) {
      trackSentMessage(command);
      appendMessage({ type: 'user', content: command });
      input.value = '';
      autoResize(input);
      navigator.vibrate?.(30);
      showToast('Sent!', 'success');
    } else {
      // Failed send: leave command in input field (Kieran's feedback)
      showToast('Send failed - command in input', 'error');
    }
  }

  // Re-enable trigger listening after a brief pause
  if (settings.triggerEnabled) {
    setTimeout(() => {
      if (settings.triggerEnabled && triggerState === TRIGGER_STATE.IDLE) {
        triggerState = TRIGGER_STATE.LISTENING;
        recognition.continuous = !isIOS;
        try { recognition.start(); } catch (e) {}
        updateTriggerUI();
      }
    }, TRIGGER_RESTART_DELAY_MS);
  } else {
    updateTriggerUI();
  }
}

function updateTriggerUI() {
  const voiceBtn = document.getElementById('voiceBtn');
  voiceBtn.classList.remove('recording', 'trigger-listening', 'trigger-capturing');

  switch (triggerState) {
    case TRIGGER_STATE.LISTENING:
      voiceBtn.classList.add('trigger-listening');
      break;
    case TRIGGER_STATE.CAPTURING:
      voiceBtn.classList.add('trigger-capturing');
      break;
  }
}

// ============================================
// Notifications
// ============================================
function sendNotification(title, body) {
  if (!('Notification' in window)) return;

  if (Notification.permission === 'granted') {
    new Notification(title, { body, icon: '⚡' });
  } else if (Notification.permission !== 'denied') {
    Notification.requestPermission().then(permission => {
      if (permission === 'granted') {
        new Notification(title, { body });
      }
    });
  }
}

// ============================================
// Settings
// ============================================
function openSettings() {
  document.getElementById('settingsPanel').classList.add('open');
  document.getElementById('settingsOverlay').classList.add('open');
}

function closeSettings() {
  document.getElementById('settingsPanel').classList.remove('open');
  document.getElementById('settingsOverlay').classList.remove('open');
}

function updateSettings() {
  settings.ttsEnabled = document.getElementById('ttsEnabled').checked;
  settings.speakTools = document.getElementById('speakTools').checked;
  settings.voiceURI = document.getElementById('voiceSelect').value;
  settings.speechRate = parseFloat(document.getElementById('speechRate').value);
  settings.notifyEnabled = document.getElementById('notifyEnabled').checked;
  debugMode = document.getElementById('debugEnabled').checked;

  const triggerToggle = document.getElementById('triggerEnabled');
  const triggerWanted = triggerToggle.checked;

  safeSetItem(localStorage, 'tts_enabled', settings.ttsEnabled);
  safeSetItem(localStorage, 'speak_tools', settings.speakTools);
  safeSetItem(localStorage, 'voice_uri', settings.voiceURI);
  safeSetItem(localStorage, 'speech_rate', settings.speechRate);
  safeSetItem(localStorage, 'notify_enabled', settings.notifyEnabled);
  safeSetItem(localStorage, 'debug_mode', debugMode);

  updateTTSButton();

  // Handle trigger mode toggle from settings
  if (triggerWanted && triggerState === TRIGGER_STATE.IDLE) {
    enableTriggerMode();
  } else if (!triggerWanted && triggerState !== TRIGGER_STATE.IDLE) {
    disableTriggerMode();
  }

  // Request notification permission if enabling
  if (settings.notifyEnabled && 'Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }

  if (debugMode) showToast('Debug mode ON', 'success');
}

// ============================================
// Mode Indicator (matches iOS InputBarView)
// ============================================
function updateModeIndicator() {
  const btn = document.getElementById('modeBtn');
  const icon = document.getElementById('modeIcon');
  const label = document.getElementById('modeLabel');
  if (!btn) return;

  // Remove old mode classes
  btn.classList.remove('mode-default', 'mode-plan', 'mode-acceptEdits');

  switch (currentMode) {
    case 'plan':
      btn.classList.add('mode-plan');
      label.textContent = 'Plan';
      icon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/></svg>';
      break;
    case 'acceptEdits':
      btn.classList.add('mode-acceptEdits');
      label.textContent = 'Accept Edits';
      icon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>';
      break;
    default:
      btn.classList.add('mode-default');
      label.textContent = 'Default';
      icon.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 16V4m0 0L3 8m4-4l4 4M17 8v12m0 0l4-4m-4 4l-4-4"/></svg>';
      break;
  }
}

// ============================================
// Status Bar and Token Tracking
// ============================================
let sessionTokens = { input: 0, output: 0 };
let statusTimeout = null;

// Update Yes button visibility based on Claude's state
function updateActionButtons() {
  const yesBtn = document.getElementById('yesBtn');
  const promptCard = document.getElementById('promptCard');

  const isWaiting = promptCard.classList.contains('show');

  // Show Yes only when Claude is waiting for input
  yesBtn.classList.toggle('hidden', !isWaiting);
}

function handleStatusUpdate(data) {
  // Update session label status text (subtle, in header)
  updateSessionStatusText('processing', data.content);
  updateActionButtons();

  // Auto-clear status text after 5 seconds of no updates
  clearTimeout(statusTimeout);
  statusTimeout = setTimeout(() => {
    updateActionButtons();
    updateSessionStatusText('idle');
  }, 5000);
}

function updateSessionStatusText(status, activity) {
  const el = document.getElementById('sessionStatusText');
  if (!el) return;

  el.className = 'session-status-text';

  if (status === 'processing' || status === 'active') {
    el.textContent = activity || 'Processing';
    el.classList.add('active', 'processing');
  } else if (status === 'waiting') {
    el.textContent = 'Waiting for input';
    el.classList.add('active', 'waiting');
  } else {
    // idle/unknown — show branch or hide
    const selector = document.getElementById('sessionSelector');
    const option = selector.selectedOptions[0];
    const branch = option?.dataset?.branch;
    if (branch) {
      el.textContent = branch;
      el.classList.add('active');
    }
    // else leave hidden (no active class)
  }
}

function handleTokenUsage(data) {
  sessionTokens.input += data.input || 0;
  sessionTokens.output += data.output || 0;

  document.getElementById('tokenInput').textContent = formatTokens(sessionTokens.input);
  document.getElementById('tokenOutput').textContent = formatTokens(sessionTokens.output);

  // Show the status bar when we receive token updates
  const statusBar = document.getElementById('statusBar');
  statusBar.classList.remove('hidden');

  clearTimeout(statusTimeout);
  statusTimeout = setTimeout(() => {
    statusBar.classList.add('hidden');
  }, 5000);
}

function formatTokens(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return n.toString();
}

function resetSessionTokens() {
  sessionTokens = { input: 0, output: 0 };
  document.getElementById('tokenInput').textContent = '0';
  document.getElementById('tokenOutput').textContent = '0';
}

// ============================================
// Task Progress (Inline)
// ============================================
const tasks = new Map(); // id -> { subject, status, description, activeForm }
let pendingSubagentInfo = null;

function handleTaskCreate(data) {
  tasks.set(data.id, {
    subject: data.subject,
    status: data.status || 'pending',
    description: data.description,
    activeForm: data.activeForm
  });
  renderTasksInline();
}

function handleTaskUpdate(data) {
  const task = tasks.get(data.id);
  if (task) {
    if (data.status) task.status = data.status;
    if (data.subject) task.subject = data.subject;
    renderTasksInline();
  }
}

function handleTaskList(data) {
  // Replace all tasks with the authoritative list
  tasks.clear();
  if (data.tasks && Array.isArray(data.tasks)) {
    for (const task of data.tasks) {
      tasks.set(task.id, {
        subject: task.subject,
        status: task.status,
        description: task.description || ''
      });
    }
  }
  renderTasksInline();
}

function renderTasksInline() {
  const container = document.getElementById('taskList');
  if (!container) return;

  if (tasks.size === 0) {
    container.classList.add('hidden');
    return;
  }

  const completed = [...tasks.values()].filter(t => t.status === 'completed').length;
  const total = tasks.size;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  container.classList.remove('hidden');
  container.innerHTML = '';
  container.onclick = showTaskSheet;

  const summary = document.createElement('div');
  summary.className = 'task-summary';
  summary.innerHTML = `
    <span class="task-summary-label">Tasks ${completed}/${total}</span>
    <div class="task-summary-bar">
      <div class="task-summary-fill" style="width: ${pct}%"></div>
    </div>
  `;
  container.appendChild(summary);
}

function clearTasks() {
  tasks.clear();
  renderTasksInline();
}

function showTaskSheet() {
  const overlay = document.getElementById('taskSheetOverlay');
  const sheet = document.getElementById('taskSheet');
  const list = document.getElementById('taskSheetList');
  const progressFill = document.getElementById('taskSheetProgressFill');

  const completed = [...tasks.values()].filter(t => t.status === 'completed').length;
  const total = tasks.size;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;
  progressFill.style.width = pct + '%';

  list.innerHTML = '';
  tasks.forEach((task, id) => {
    const item = document.createElement('div');
    item.className = 'task-sheet-item';
    const statusIcon = task.status === 'completed' ? '✅' :
                       task.status === 'in_progress' ? '🔄' : '⏳';
    let html = `<div class="task-sheet-row">
      <span class="task-sheet-icon">${statusIcon}</span>
      <span class="task-sheet-subject">${escapeHtml(task.subject || '')}</span>
    </div>`;
    if (task.status === 'in_progress' && task.activeForm) {
      html += `<div class="task-sheet-active">${escapeHtml(task.activeForm)}</div>`;
    }
    if (task.description) {
      html += `<div class="task-sheet-desc">${escapeHtml(task.description)}</div>`;
      item.onclick = () => item.classList.toggle('expanded');
    }
    item.innerHTML = html;
    list.appendChild(item);
  });

  overlay.classList.add('show');
  sheet.classList.add('show');
}

function hideTaskSheet() {
  document.getElementById('taskSheetOverlay').classList.remove('show');
  document.getElementById('taskSheet').classList.remove('show');
}

// ============================================
// Milestones Timeline
// ============================================

function addMilestone(text, timestamp, toolCount) {
  milestones.push({ text, timestamp, toolCount: toolCount || 0 });
  renderMilestones();
}

function setMilestones(items) {
  milestones = items.map(m => ({ text: m.text, timestamp: m.timestamp, toolCount: m.toolCount || 0 }));
  renderMilestones();
}

function renderMilestones() {
  const container = document.getElementById('milestonesContainer');
  if (!container) return;

  if (milestones.length === 0) {
    container.style.display = 'none';
    return;
  }

  container.style.display = '';
  const header = container.querySelector('.milestones-header');
  const list = container.querySelector('.milestones-list');
  const countEl = header?.querySelector('.milestones-count');

  if (countEl) countEl.textContent = milestones.length;

  if (!list) return;
  list.innerHTML = '';

  // Reverse chronological order
  const sorted = [...milestones].reverse();
  for (const m of sorted) {
    const row = document.createElement('div');
    row.className = 'milestone-row';

    const dot = document.createElement('div');
    dot.className = 'milestone-dot';

    const content = document.createElement('div');
    content.className = 'milestone-content';

    const text = document.createElement('div');
    text.className = 'milestone-text';
    text.textContent = m.text;
    text.title = m.text; // Full text on hover

    const meta = document.createElement('div');
    meta.className = 'milestone-meta';

    if (m.timestamp) {
      const time = document.createElement('span');
      time.className = 'milestone-time';
      time.textContent = formatRelativeTime(m.timestamp);
      meta.appendChild(time);
    }
    if (m.toolCount > 0) {
      const badge = document.createElement('span');
      badge.className = 'milestone-tool-badge';
      badge.textContent = `${m.toolCount} tools`;
      meta.appendChild(badge);
    }

    content.appendChild(text);
    content.appendChild(meta);
    row.appendChild(dot);
    row.appendChild(content);
    list.appendChild(row);
  }
}

function formatRelativeTime(timestamp) {
  const now = Date.now();
  const ts = new Date(timestamp).getTime();
  const diff = Math.max(0, now - ts);
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function toggleMilestones() {
  const list = document.querySelector('.milestones-list');
  const header = document.querySelector('.milestones-header');
  if (!list || !header) return;
  const isExpanded = list.classList.toggle('expanded');
  header.classList.toggle('expanded', isExpanded);
}

// ============================================
// Subagent Handling
// ============================================

// Persistent inline activity cards (matches iOS SubagentActivityCard lifecycle)
function createSubagentActivityCard(description, agentType) {
  const card = document.createElement('div');
  card.className = 'subagent-activity-card starting';
  card.innerHTML = `
    <div class="subagent-card-icon">
      <span class="subagent-card-spinner"></span>
    </div>
    <div class="subagent-card-content">
      <span class="subagent-card-status">Starting</span>: <span class="subagent-card-desc">${escapeHtml(description || 'Subagent')}</span>
      <span class="subagent-card-tool"></span>
    </div>
  `;
  return card;
}

function updateSubagentCardStatus(card, status) {
  if (!card) return;
  card.classList.remove('starting', 'running', 'completed');
  card.classList.add(status);

  const iconEl = card.querySelector('.subagent-card-icon');
  const statusEl = card.querySelector('.subagent-card-status');
  const toolEl = card.querySelector('.subagent-card-tool');

  if (status === 'running') {
    statusEl.textContent = 'Running';
  } else if (status === 'completed') {
    statusEl.textContent = 'Completed';
    iconEl.innerHTML = '<span class="subagent-card-check">✓</span>';
    if (toolEl) toolEl.textContent = '';
  }
}

function updateSubagentCardTool(card, tool) {
  if (!card) return;
  const toolEl = card.querySelector('.subagent-card-tool');
  if (toolEl) {
    toolEl.textContent = tool ? ` — ${tool}` : '';
  }
}

function updateSubagentIndicator() {
  const indicator = document.getElementById('subagentIndicator');
  const badgeEl = indicator.querySelector('.subagent-badge');

  const count = activeSubagents.size;
  if (count === 0) {
    indicator.classList.add('hidden');
    activeTeamName = null;
    return;
  }

  indicator.classList.remove('hidden');

  // Show team name in badge when a team is active
  let hasTeammates = false;
  if (activeTeamName) {
    activeSubagents.forEach(agent => { if (agent.teamName) hasTeammates = true; });
  }

  if (hasTeammates) {
    badgeEl.innerHTML = `<span class="subagent-count">${count}</span> ${escapeHtml(activeTeamName)}`;
    indicator.classList.add('team-active');
  } else {
    badgeEl.innerHTML = `<span class="subagent-count">${count}</span>`;
    indicator.classList.remove('team-active');
  }
}

function handleSubagentOutput(agentId, data) {
  // Update subagent activity tracking
  const subagent = activeSubagents.get(agentId);
  if (subagent) {
    subagent.lastActivity = Date.now();

    // Update description based on message type
    if (data.type === 'tool') {
      subagent.description = `Using ${data.tool}`;
      subagent.status = 'running';
    } else if (data.type === 'assistant') {
      subagent.description = data.content?.substring(0, 30) + '...' || 'Thinking...';
    }

    // Check if it's waiting for input
    if (data.type === 'permission_request' || data.type === 'ask_user_question') {
      subagent.status = 'waiting';
      subagent.description = 'Waiting for input';
    }

    updateSubagentIndicator();
  }

  // Handle tool_result FIRST - cancel pending permission or dismiss shown card
  if (data.type === 'tool_result') {
    // Cancel pending permission card (auto-approved before delay)
    const pending = pendingSubagentPermissions.get(agentId);
    if (pending) {
      clearTimeout(pending.timeout);
      pendingSubagentPermissions.delete(agentId);
    }
    // Dismiss shown permission card
    if (currentPrompt?.type === 'permission' && currentPrompt?.subagentId === agentId) {
      hidePromptCard();
    }
    return;
  }

  // Handle subagent permission requests with delay (allows auto-approve to cancel)
  if (data.type === 'permission_request') {
    // Show tool usage in terminal (as tool card with orange styling)
    appendMessage({ type: 'tool', tool: data.tool, input: data.input || {}, timestamp: data.timestamp }, true, false, agentId);

    const input = data.input || {};
    const tool = data.tool;
    const cmd = tool === 'Bash' ? (input.command || '') : `${tool}: ${input.file_path || 'unknown'}`;
    const isDestructive = tool === 'Bash' && /\brm\b|\bdelete\b|\bdrop\b/.test(cmd.toLowerCase());

    // Cancel any existing pending permission for this subagent
    const existing = pendingSubagentPermissions.get(agentId);
    if (existing) clearTimeout(existing.timeout);

    // Delay showing card - if tool_result comes quickly, it was auto-approved
    const toolUseId = data.toolUseId || null;
    const timeout = setTimeout(() => {
      pendingSubagentPermissions.delete(agentId);
      showPromptCard({
        type: 'permission',
        text: `Allow ${tool}?`,
        tool: tool,
        toolUseId: toolUseId,
        command: cmd,
        isDestructive: isDestructive,
        subagentId: agentId
      });
    }, PERMISSION_CARD_DELAY_MS);

    pendingSubagentPermissions.set(agentId, { timeout, tool, cmd, isDestructive, toolUseId });
    return;
  }

  // Handle subagent AskUserQuestion
  if (data.type === 'ask_user_question') {
    showStructuredPrompt(data.questions, agentId);
    return;
  }

  // Only show subagent tool usage in terminal (with orange styling)
  // Skip assistant text/thoughts - mirrors Claude Code terminal behavior
  if (data.type === 'tool') {
    appendMessage(data, true, false, agentId);
  }
}

// ============================================
// Voice Integration for Prompts
// ============================================
function speakThenListen(text) {
  if (!settings.ttsEnabled || !synth) return;

  // Pause trigger listening during TTS to avoid picking up speaker audio
  const wasTriggerListening = triggerState === TRIGGER_STATE.LISTENING;
  if (wasTriggerListening) {
    try { recognition.stop(); } catch (e) {}
    isRecording = false;
  } else if (recognition && isRecording) {
    recognition.stop();
    isRecording = false;
  }

  synth.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = settings.speechRate;

  if (settings.voiceURI !== 'default') {
    const voices = synth.getVoices();
    const voice = voices.find(v => v.voiceURI === settings.voiceURI);
    if (voice) utterance.voice = voice;
  }

  utterance.onend = () => {
    // Wait before starting listening for response (avoids TTS echo detection)
    setTimeout(() => {
      if (currentPrompt && recognition) {
        startListeningForPromptResponse();
      } else if (wasTriggerListening && settings.triggerEnabled && triggerState === TRIGGER_STATE.LISTENING) {
        // Resume trigger listening after TTS completes
        try { recognition.start(); } catch (e) {}
      }
    }, VOICE_LISTEN_DELAY_MS);
  };

  synth.speak(utterance);
}

function startListeningForPromptResponse() {
  if (!recognition || isRecording) return;

  recognition.start();
  isRecording = true;
  document.getElementById('voiceBtn')?.classList.add('recording');
}

function handleVoicePromptResponse(transcript) {
  if (!currentPrompt) return false;

  const text = transcript.toLowerCase().trim();

  // Yes responses
  if (['yes', 'yeah', 'yep', 'okay', 'ok', 'proceed', 'sure', 'go ahead', 'do it'].includes(text)) {
    respondToPrompt('y');
    return true;
  }

  // No responses
  if (['no', 'nope', 'cancel', 'stop', "don't", 'abort', 'negative'].includes(text)) {
    respondToPrompt('n');
    return true;
  }

  // Option selection (for multi-choice)
  if (currentPrompt.type === 'multiChoice') {
    const optionMatch = text.match(/^(?:option\s+)?(\d+|one|two|three|four|five|first|second|third|fourth|fifth)$/i);
    if (optionMatch) {
      const numMap = { one: '1', two: '2', three: '3', four: '4', five: '5', first: '1', second: '2', third: '3', fourth: '4', fifth: '5' };
      const num = numMap[optionMatch[1].toLowerCase()] || optionMatch[1];
      respondToPrompt(num);
      return true;
    }
  }

  // Free-form: use the transcript as-is
  if (currentPrompt.type === 'freeForm') {
    respondToPrompt(transcript);
    return true;
  }

  return false;
}

// ============================================
// Document Viewer
// ============================================
const docViewerStack = []; // breadcrumb stack of paths

function showDocumentViewer() {
  if (!currentSessionId) return;
  docViewerStack.length = 0;
  document.getElementById('docViewerOverlay').classList.add('show');
  document.getElementById('docViewer').classList.add('show');
  loadDirectory('.');
}

function hideDocumentViewer() {
  document.getElementById('docViewerOverlay').classList.remove('show');
  document.getElementById('docViewer').classList.remove('show');
}

async function loadDirectory(dirPath) {
  const content = document.getElementById('docViewerContent');
  const pathEl = document.getElementById('docViewerPath');
  const backBtn = document.getElementById('docViewerBack');
  content.innerHTML = '<div class="doc-viewer-loading">Loading...</div>';
  pathEl.textContent = dirPath === '.' ? 'Files' : dirPath.split('/').pop();
  backBtn.style.display = docViewerStack.length > 0 ? '' : 'none';

  try {
    const res = await fetch(`/api/files?sessionId=${encodeURIComponent(currentSessionId)}&path=${encodeURIComponent(dirPath)}`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();

    if (!data.entries || data.entries.length === 0) {
      content.innerHTML = '<div class="doc-viewer-loading">Empty directory</div>';
      return;
    }

    const list = document.createElement('ul');
    list.className = 'doc-file-list';
    for (const entry of data.entries) {
      const li = document.createElement('li');
      li.className = 'doc-file-item';
      const icon = entry.isDirectory ? '📁' : getFileIcon(entry.name);
      li.innerHTML = `<span class="doc-file-icon">${icon}</span><span class="doc-file-name">${escapeHtml(entry.name)}</span>${entry.isDirectory ? '<span class="doc-file-chevron">›</span>' : ''}`;
      if (entry.isDirectory) {
        li.onclick = () => {
          docViewerStack.push(dirPath);
          loadDirectory(dirPath === '.' ? entry.name : dirPath + '/' + entry.name);
        };
      } else {
        li.onclick = () => {
          docViewerStack.push(dirPath);
          loadFile(dirPath === '.' ? entry.name : dirPath + '/' + entry.name, entry.name);
        };
      }
      list.appendChild(li);
    }
    content.innerHTML = '';
    content.appendChild(list);
  } catch (e) {
    content.innerHTML = `<div class="doc-viewer-loading">Error: ${escapeHtml(e.message)}</div>`;
  }
}

async function loadFile(filePath, fileName) {
  const content = document.getElementById('docViewerContent');
  const pathEl = document.getElementById('docViewerPath');
  const backBtn = document.getElementById('docViewerBack');
  content.innerHTML = '<div class="doc-viewer-loading">Loading...</div>';
  pathEl.textContent = fileName || filePath.split('/').pop();
  backBtn.style.display = '';

  try {
    const res = await fetch(`/api/file?sessionId=${encodeURIComponent(currentSessionId)}&path=${encodeURIComponent(filePath)}`, {
      headers: { 'Authorization': `Bearer ${authToken}` }
    });
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();

    content.innerHTML = '';

    // Actions bar (copy)
    const actions = document.createElement('div');
    actions.className = 'doc-file-actions';
    const copyBtn = document.createElement('button');
    copyBtn.className = 'doc-copy-btn';
    copyBtn.textContent = 'Copy';
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(data.content).then(() => {
        copyBtn.textContent = 'Copied!';
        setTimeout(() => copyBtn.textContent = 'Copy', 1500);
      });
    };
    actions.appendChild(copyBtn);
    content.appendChild(actions);

    // Content area
    const contentDiv = document.createElement('div');
    contentDiv.className = 'doc-file-content';

    if (data.language === 'markdown' && window.marked && window.DOMPurify) {
      const rendered = DOMPurify.sanitize(marked.parse(data.content, { breaks: true }), PURIFY_CONFIG);
      contentDiv.innerHTML = `<div class="markdown-body">${rendered}</div>`;
    } else {
      contentDiv.innerHTML = `<pre>${escapeHtml(data.content)}</pre>`;
    }
    content.appendChild(contentDiv);
  } catch (e) {
    content.innerHTML = `<div class="doc-viewer-loading">Error: ${escapeHtml(e.message)}</div>`;
  }
}

function docViewerBack() {
  if (docViewerStack.length === 0) {
    hideDocumentViewer();
    return;
  }
  const prev = docViewerStack.pop();
  loadDirectory(prev);
}

function getFileIcon(name) {
  const ext = name.includes('.') ? name.substring(name.lastIndexOf('.')) : '';
  const icons = {
    '.js': '📄', '.ts': '📄', '.jsx': '📄', '.tsx': '📄',
    '.swift': '🔶', '.py': '🐍', '.rb': '💎', '.go': '🔵',
    '.rs': '🦀', '.java': '☕', '.kt': '🟣',
    '.json': '📋', '.yaml': '📋', '.yml': '📋', '.toml': '📋',
    '.md': '📝', '.txt': '📄',
    '.html': '🌐', '.css': '🎨', '.scss': '🎨',
    '.sh': '⚙️', '.zsh': '⚙️',
    '.sql': '🗃️',
    '.png': '🖼️', '.jpg': '🖼️', '.gif': '🖼️', '.svg': '🖼️',
  };
  return icons[ext] || '📄';
}
