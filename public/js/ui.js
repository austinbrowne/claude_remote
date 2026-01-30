// ============================================
// Command Sending
// ============================================
function sendCommand() {
  const input = document.getElementById('commandInput');
  const sendBtn = document.getElementById('sendBtn');
  const command = input.value.trim();

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

  if (activeSubagents.size === 0) {
    list.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--text-muted);">No active subagents</div>';
  } else {
    activeSubagents.forEach((agent, id) => {
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
    });
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
// Command Autocomplete
// ============================================
const COMMANDS = [
  { cmd: '/workflows:plan', desc: 'Create implementation plan' },
  { cmd: '/workflows:work', desc: 'Execute a plan' },
  { cmd: '/workflows:review', desc: 'Code review with agents' },
  { cmd: '/workflows:brainstorm', desc: 'Explore approaches' },
  { cmd: '/workflows:compound', desc: 'Document a solved problem' },
  { cmd: '/commit', desc: 'Commit changes' },
  { cmd: '/commit-and-pr', desc: 'Commit and create PR' },
  { cmd: '/clear', desc: 'Clear conversation' },
  { cmd: '/compact', desc: 'Compact context' },
  { cmd: '/status', desc: 'Show status' },
  { cmd: '/help', desc: 'Show help' },
  { cmd: '/plan', desc: 'Enter plan mode' },
  { cmd: '/explore', desc: 'Explore codebase' },
  { cmd: '/security-review', desc: 'Security checklist' },
  { cmd: '/generate-tests', desc: 'Generate tests' },
  { cmd: '/fresh-eyes-review', desc: 'Unbiased code review' },
  { cmd: '/refactor', desc: 'Guided refactoring' },
];

let autocompleteIndex = -1;

function handleInput(el) {
  autoResize(el);
  const value = el.value;

  if (value.startsWith('/')) {
    const query = value.toLowerCase();
    const matches = COMMANDS.filter(c => c.cmd.toLowerCase().includes(query));
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
  const statusBar = document.getElementById('statusBar');
  const statusVerb = document.getElementById('statusVerb');

  statusBar.classList.remove('hidden');
  statusVerb.textContent = data.text || 'Working...';
  updateActionButtons();

  // Auto-hide after 5 seconds of no updates
  clearTimeout(statusTimeout);
  statusTimeout = setTimeout(() => {
    statusBar.classList.add('hidden');
    updateActionButtons();
  }, 5000);
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

  container.classList.remove('hidden');
  container.innerHTML = '';

  tasks.forEach((task, id) => {
    const div = document.createElement('div');
    div.className = `task-inline ${task.status}`;
    div.innerHTML = `
      <span class="task-icon"></span>
      <span class="task-subject">${escapeHtml(task.subject || '')}</span>
    `;
    container.appendChild(div);
  });
}

function clearTasks() {
  tasks.clear();
  renderTasksInline();
}

// ============================================
// Subagent Handling
// ============================================
function updateSubagentIndicator() {
  const indicator = document.getElementById('subagentIndicator');
  const countEl = indicator.querySelector('.subagent-count');

  const count = activeSubagents.size;
  if (count === 0) {
    indicator.classList.add('hidden');
    return;
  }

  indicator.classList.remove('hidden');
  countEl.textContent = count;
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
    const timeout = setTimeout(() => {
      pendingSubagentPermissions.delete(agentId);
      showPromptCard({
        type: 'permission',
        text: `Allow ${tool}?`,
        command: cmd,
        isDestructive: isDestructive,
        subagentId: agentId
      });
    }, PERMISSION_CARD_DELAY_MS);

    pendingSubagentPermissions.set(agentId, { timeout, tool, cmd, isDestructive });
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
