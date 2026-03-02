// ============================================
// Interactive Prompt Response UI
// ============================================
const PROMPT_STYLES = {
  permission: { icon: '!', title: 'Permission Required', className: 'permission' },
  yesNo: { icon: '?', title: 'Question', className: '' },
  multiChoice: { icon: '#', title: 'Pick an option', className: '' },
  freeForm: { icon: 'A', title: 'Your input needed', className: '' },
  planExit: { icon: 'P', title: 'Plan Mode Ending', className: '' }
};

const DESTRUCTIVE_KEYWORDS = ['delete', 'remove', 'drop', 'destroy', 'reset', 'force', 'overwrite', 'erase'];
const VALID_APPROVAL_COMMANDS = ['y', 'n', 'always'];
const FALLBACK_DEBOUNCE_MS = 2000; // Must match Swift fallbackDebounceSeconds

let currentPrompt = null;
let promptMessageIndex = 0;
const promptQueue = [];
const minimizedPrompts = [];
let fallbackApprovalTimer = null;
let lastRespondedAt = 0; // Timestamp of last prompt response (suppresses fallback flash)

function isDestructivePrompt(text) {
  const lower = text.toLowerCase();
  return DESTRUCTIVE_KEYWORDS.some(k => lower.includes(k));
}

function detectPromptType(content) {
  // Only check last portion of message to avoid false positives
  const lines = content.split('\n').filter(l => l.trim());
  const lastPortion = lines.slice(-5).join('\n'); // Last 5 lines
  const lastLine = lines[lines.length - 1] || content;

  // Must end with a question or have explicit prompt markers
  const hasQuestion = /\?\s*$/.test(lastLine.trim());
  const hasExplicitMarker = /\(y\/n\)|\[y\/n\]|\[yes\/no\]/i.test(lastPortion);

  if (!hasQuestion && !hasExplicitMarker) return null;

  // Permission prompts
  if (/\(y\/n\)|\[y\/n\]|run this command|allow this|approve|execute/i.test(lastPortion)) {
    // Try to extract the command being requested
    const commandMatch = content.match(/`([^`]+)`|"([^"]+)"|run[:\s]+(.+?)(?:\?|$)/i);
    const command = commandMatch ? (commandMatch[1] || commandMatch[2] || commandMatch[3]) : null;
    return { type: 'permission', text: content, command, isDestructive: isDestructivePrompt(content) };
  }

  // Multiple choice - look for numbered/lettered options with a question
  const options = [];
  const optionPatterns = [
    /^(\d+)[.)]\s+(.+)$/gm,
    /^([A-D])[.)]\s+(.+)$/gim,
  ];
  for (const pattern of optionPatterns) {
    const matches = content.matchAll(pattern);
    for (const match of matches) {
      const optText = match[2].replace(/\*\*/g, '').trim();
      if (optText.length > 0) {
        options.push({ num: match[1], text: optText });
      }
    }
  }
  if (options.length >= 2 && hasQuestion) {
    return { type: 'multiChoice', options, text: content };
  }

  // Yes/No explicit
  if (/yes or no|\(yes\/no\)|should I|want me to|shall I|do you want/i.test(lastPortion) && hasQuestion) {
    return { type: 'yesNo', text: content, isDestructive: isDestructivePrompt(content) };
  }

  // Free-form feedback request
  if (/what would you like|please describe|tell me more|any feedback|your thoughts/i.test(lastPortion)) {
    return { type: 'freeForm', text: content };
  }

  return null;
}

function showPlanExitPrompt() {
  showPromptCard({
    type: 'planExit',
    text: 'Plan mode is ending. How would you like to proceed?',
    multiSelect: false,
    options: [
      { num: '1', text: 'Preserve context and continue' },
      { num: '2', text: 'Clear context and start fresh' },
      { num: '3', text: 'Manual approve (review plan first)' },
      { num: '4', text: 'Request changes to the plan' }
    ]
  });
}

function showStructuredPrompt(questions, subagentId = null) {
  // Defensive checks
  if (!Array.isArray(questions) || questions.length === 0) return;

  // Build a prompt for each question and show/queue them all
  const prompts = questions
    .filter(q => q.question && Array.isArray(q.options))
    .map(q => ({
      type: 'multiChoice',
      text: q.question,
      multiSelect: q.multiSelect === true,
      subagentId: subagentId,
      isStructured: true, // Use select_option/select_other instead of inject
      options: q.options.map((opt, i) => ({
        num: (i + 1).toString(),
        text: opt.description ? `${opt.label}: ${opt.description}` : opt.label
      }))
    }));

  // Show first prompt immediately, queue the rest
  for (const prompt of prompts) {
    showPromptCard(prompt);
  }
}

function showPromptCard(prompt) {
  // Skip if tool is pre-allowed (from claudeState permissions)
  if (prompt.type === 'permission' && prompt.tool && alwaysAllowedTools.has(prompt.tool)) {
    return;
  }

  // Queue if a prompt is already showing
  if (currentPrompt) {
    promptQueue.push(prompt);
    // If current prompt is same-tool permission, update batch button count
    if (currentPrompt.type === 'permission' && prompt.type === 'permission'
        && currentPrompt.tool && currentPrompt.tool === prompt.tool) {
      updateBatchButton();
    }
    return;
  }

  const card = document.getElementById('promptCard');
  const content = document.getElementById('promptContent');
  const actions = document.getElementById('promptActions');
  const icon = document.getElementById('promptIcon');
  const title = document.getElementById('promptTitle');

  currentPrompt = prompt;
  promptMessageIndex = document.querySelectorAll('.message').length;
  hideFallbackApproval();

  // Apply styling based on prompt type
  const style = PROMPT_STYLES[prompt.type];
  card.className = 'prompt-card show ' + style.className;
  if (prompt.isDestructive) card.classList.add('destructive');
  icon.textContent = style.icon;
  title.textContent = style.title;

  // Extract the question (last meaningful line)
  const lines = prompt.text.split('\n').filter(l => l.trim());
  const question = lines.find(l => /\?/.test(l)) || lines[lines.length - 1] || prompt.text;

  switch (prompt.type) {
    case 'permission':
      let permissionHtml = '';
      if (prompt.subagentId) {
        permissionHtml += `<div class="subagent-context">🤖 Subagent: ${prompt.subagentId.substring(0, 7)}</div>`;
      }
      permissionHtml += `<p>${escapeHtml(question)}</p>`;
      if (prompt.command) {
        permissionHtml += `<div class="prompt-command-preview"><code>${escapeHtml(formatPermissionDisplay(prompt.tool, prompt.command))}</code></div>`;
      }
      content.innerHTML = permissionHtml;
      // Claude Code uses numbered options: 1=Yes (once), 2=Yes and always allow, 3=No
      const toolName = prompt.tool || '';
      const toolUseId = prompt.toolUseId || '';
      // Count same-tool permissions in queue (+ current = total)
      const sameToolQueued = promptQueue.filter(p => p.type === 'permission' && p.tool === toolName).length;
      const sameToolTotal = sameToolQueued + 1; // +1 for current prompt
      const totalPermissions = promptQueue.filter(p => p.type === 'permission').length + 1;
      const hasMixedTools = totalPermissions > 1 && totalPermissions !== sameToolTotal;
      actions.innerHTML = `
        <button class="prompt-btn ${prompt.isDestructive ? 'secondary' : 'primary'}" data-action="yes">Yes</button>
        <button class="prompt-btn allow-always" data-action="always">Always Allow</button>
        <button class="prompt-btn ${prompt.isDestructive ? 'primary destructive' : 'secondary'}" data-action="no">No</button>
        ${sameToolTotal > 1 && toolName ? `<button class="prompt-btn allow-all" data-action="allow-all">Allow All ${escapeHtml(toolName)} (${sameToolTotal})</button>` : ''}
        ${hasMixedTools ? `<button class="prompt-btn approve-all" data-action="approve-all">Approve All (${totalPermissions})</button>` : ''}
      `;
      // Attach handlers programmatically to avoid inline string interpolation (XSS defense)
      actions.querySelector('[data-action="yes"]').addEventListener('click', () => respondToPrompt('1'));
      actions.querySelector('[data-action="always"]').addEventListener('click', () => respondToPermission(toolName, toolUseId));
      actions.querySelector('[data-action="no"]').addEventListener('click', () => respondToPrompt('3'));
      const allowAllBtn = actions.querySelector('[data-action="allow-all"]');
      if (allowAllBtn) allowAllBtn.addEventListener('click', () => respondToPermission(toolName, toolUseId));
      const approveAllBtn = actions.querySelector('[data-action="approve-all"]');
      if (approveAllBtn) approveAllBtn.addEventListener('click', () => approveAllPermissions());
      break;

    case 'yesNo':
      content.innerHTML = `<p>${escapeHtml(question)}</p>`;
      const yesClass2 = prompt.isDestructive ? 'secondary' : 'primary';
      const noClass2 = prompt.isDestructive ? 'primary destructive' : 'secondary';
      actions.innerHTML = `
        <button class="prompt-btn ${yesClass2}" onclick="respondToPrompt('y')">Yes</button>
        <button class="prompt-btn ${noClass2}" onclick="respondToPrompt('n')">No</button>
      `;
      break;

    case 'planExit':
    case 'multiChoice':
      let multiHtml = prompt.subagentId ? `<div class="subagent-context">🤖 Subagent: ${prompt.subagentId.substring(0, 7)}</div>` : '';
      multiHtml += `<p>${escapeHtml(question)}</p>`;
      content.innerHTML = multiHtml;
      const useDropdown = prompt.options.length > 5 && !prompt.multiSelect;
      const isMulti = prompt.multiSelect;
      if (useDropdown) {
        content.innerHTML += `
          <select class="prompt-select" id="promptSelect">
            <option value="">Select an option...</option>
            ${prompt.options.map(opt => `<option value="${opt.num}">${escapeHtml(opt.num)}. ${escapeHtml(opt.text)}</option>`).join('')}
          </select>
        `;
        actions.innerHTML = `<button class="prompt-btn primary" onclick="submitDropdownChoice()">Select</button>`;
      } else {
        content.innerHTML += `<div class="prompt-options-scroll" data-multi="${isMulti}">
          ${prompt.options.map((opt, i) => `
            <div class="prompt-option" data-value="${opt.num}" onclick="selectOption(this, ${isMulti})" tabindex="0" role="${isMulti ? 'checkbox' : 'radio'}" aria-checked="false">
              <span>${isMulti ? '☐ ' : ''}${escapeHtml(opt.num)}. ${escapeHtml(opt.text)}</span>
            </div>
          `).join('')}
        </div>`;
        actions.innerHTML = `<button class="prompt-btn primary" onclick="submitChoice(${isMulti})">Select</button>`;
      }
      break;

    case 'freeForm':
      content.innerHTML = `
        <p>${escapeHtml(question)}</p>
        <textarea class="prompt-input" id="promptInput" placeholder="Type your response..." rows="2"></textarea>
      `;
      actions.innerHTML = `<button class="prompt-btn primary" onclick="submitFreeform()">Send</button>`;
      setTimeout(() => document.getElementById('promptInput')?.focus(), 100);
      break;
  }

  // Add freeform input to all prompt types except freeForm (which already has one)
  if (prompt.type !== 'freeForm') {
    content.innerHTML += `
      <div class="prompt-freeform">
        <input type="text" id="promptFreeformInput" placeholder="Or type a custom response..."
               onkeydown="if(event.key==='Enter')respondToPromptFreeform()">
        <button onclick="respondToPromptFreeform()">Send</button>
      </div>
    `;
  }

  card.classList.remove('loading', 'stale');

  // Focus first interactive element for accessibility
  setTimeout(() => {
    const firstInteractive = card.querySelector('button, input, textarea, select, .prompt-option');
    firstInteractive?.focus();
  }, 100);

  // Voice: read the prompt, then listen
  if (settings.ttsEnabled) {
    speakThenListen(`Claude is asking: ${question}`);
  }

  // Setup keyboard navigation for options
  setupOptionKeyboardNav();

  // Update action buttons to show Yes
  updateActionButtons();
  updatePromptQueueBadge();
  updateMinimizedIndicator();
}

function setupOptionKeyboardNav() {
  const card = document.getElementById('promptCard');
  card.onkeydown = (e) => {
    const options = [...card.querySelectorAll('.prompt-option')];
    if (options.length === 0) return;

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const current = options.findIndex(o => o.classList.contains('selected'));
      let next;
      if (e.key === 'ArrowDown') {
        next = current < 0 ? 0 : (current + 1) % options.length;
      } else {
        next = current < 0 ? options.length - 1 : (current - 1 + options.length) % options.length;
      }
      const isMulti = card.querySelector('.prompt-options-scroll')?.dataset.multi === 'true';
      selectOption(options[next], isMulti);
      options[next].focus();
    } else if (e.key === 'Enter' && document.activeElement?.classList.contains('prompt-option')) {
      e.preventDefault();
      const isMulti = card.querySelector('.prompt-options-scroll')?.dataset.multi === 'true';
      submitChoice(isMulti);
    } else if (e.key === ' ' && document.activeElement?.classList.contains('prompt-option')) {
      // Space toggles selection in multi-select mode
      e.preventDefault();
      const isMulti = card.querySelector('.prompt-options-scroll')?.dataset.multi === 'true';
      if (isMulti) {
        selectOption(document.activeElement, true);
      }
    }
  };
}

// Format permission display based on tool type
function formatPermissionDisplay(tool, input) {
  if (typeof input === 'string') return input; // Already formatted
  switch(tool) {
    case 'Bash':
      return input?.command || 'Run command';
    case 'WebFetch':
      return sanitizeUrl(input?.url) || 'Fetch URL';
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
      return input?.file_path || 'Modify file';
    case 'NotebookEdit':
      return input?.notebook_path || 'Edit notebook';
    default:
      // MCP tools - show truncated JSON input
      if (typeof input === 'object') {
        const str = JSON.stringify(input, null, 2);
        return str.length > 200 ? str.substring(0, 200) + '...' : str;
      }
      return String(input || 'Execute');
  }
}

// Sanitize URLs to remove potentially sensitive query params
function sanitizeUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return url;
  }
}

// Update or add the batch "Allow All" and "Approve All" buttons when a permission is queued
function updateBatchButton() {
  if (!currentPrompt || currentPrompt.type !== 'permission' || !currentPrompt.tool) return;
  const actions = document.getElementById('promptActions');
  if (!actions) return;
  const toolName = currentPrompt.tool;
  const toolUseId = currentPrompt.toolUseId || '';
  const sameToolQueued = promptQueue.filter(p => p.type === 'permission' && p.tool === toolName).length;
  const sameToolTotal = sameToolQueued + 1;
  const totalPermissions = promptQueue.filter(p => p.type === 'permission').length + 1;
  const hasMixedTools = totalPermissions > 1 && totalPermissions !== sameToolTotal;

  // Remove existing batch buttons if any
  const existingAllowAll = actions.querySelector('[data-action="allow-all"]');
  if (existingAllowAll) existingAllowAll.remove();
  const existingApproveAll = actions.querySelector('[data-action="approve-all"]');
  if (existingApproveAll) existingApproveAll.remove();

  if (sameToolTotal > 1) {
    const btn = document.createElement('button');
    btn.className = 'prompt-btn allow-all';
    btn.dataset.action = 'allow-all';
    btn.textContent = `Allow All ${toolName} (${sameToolTotal})`;
    btn.addEventListener('click', () => respondToPermission(toolName, toolUseId));
    actions.appendChild(btn);
  }
  if (hasMixedTools) {
    const btn = document.createElement('button');
    btn.className = 'prompt-btn approve-all';
    btn.dataset.action = 'approve-all';
    btn.textContent = `Approve All (${totalPermissions})`;
    btn.addEventListener('click', () => approveAllPermissions());
    actions.appendChild(btn);
  }
}

// Track which tools have been "always allowed" (local tracking for UI only)
const alwaysAllowedTools = new Set();

// Handle permission response with tool tracking
function respondToPermission(tool, toolUseId) {
  if (tool) {
    alwaysAllowedTools.add(tool);
    // Cascade: remove queued and minimized permissions for the same tool
    for (let i = promptQueue.length - 1; i >= 0; i--) {
      if (promptQueue[i].type === 'permission' && promptQueue[i].tool === tool) {
        promptQueue.splice(i, 1);
      }
    }
    for (let i = minimizedPrompts.length - 1; i >= 0; i--) {
      if (minimizedPrompts[i].type === 'permission' && minimizedPrompts[i].tool === tool) {
        minimizedPrompts.splice(i, 1);
      }
    }
    updateMinimizedIndicator();
  }
  // Send 'always' (matching iOS behavior) so server can track the grant,
  // and include toolUseId for accurate tool-to-grant mapping
  const card = document.getElementById('promptCard');
  card.classList.add('loading');
  navigator.vibrate?.(50);

  const msg = { action: 'inject', command: 'always', sessionId: currentSessionId };
  if (toolUseId) msg.toolUseId = toolUseId;
  const success = wsSend(msg);

  if (success) {
    trackSentMessage('always');
    appendMessage({ type: 'user', content: 'always' });
    if (settings.ttsEnabled) {
      speak('Sent: always allow');
    }
    setTimeout(() => hidePromptCard(), 300);
  } else {
    card.classList.remove('loading');
    showToast('Failed to send response', 'error');
  }
}

function approveAllPermissions() {
  if (!currentPrompt || currentPrompt.type !== 'permission') return;
  const allTools = new Set();
  if (currentPrompt.tool) allTools.add(currentPrompt.tool);
  for (const p of promptQueue) {
    if (p.type === 'permission' && p.tool) allTools.add(p.tool);
  }
  for (const p of minimizedPrompts) {
    if (p.type === 'permission' && p.tool) allTools.add(p.tool);
  }
  for (const tool of allTools) alwaysAllowedTools.add(tool);
  // Remove all permission prompts from queue and minimized (keep questions)
  for (let i = promptQueue.length - 1; i >= 0; i--) {
    if (promptQueue[i].type === 'permission') promptQueue.splice(i, 1);
  }
  for (let i = minimizedPrompts.length - 1; i >= 0; i--) {
    if (minimizedPrompts[i].type === 'permission') minimizedPrompts.splice(i, 1);
  }
  updateMinimizedIndicator();
  // Send "always" for head
  const toolUseId = currentPrompt.toolUseId || '';
  const card = document.getElementById('promptCard');
  card.classList.add('loading');
  navigator.vibrate?.(50);
  const msg = { action: 'inject', command: 'always', sessionId: currentSessionId };
  if (toolUseId) msg.toolUseId = toolUseId;
  const success = wsSend(msg);
  if (success) {
    trackSentMessage('always');
    appendMessage({ type: 'user', content: 'always' });
    if (settings.ttsEnabled) speak('Approved all permissions');
    setTimeout(() => hidePromptCard(), 300);
  } else {
    card.classList.remove('loading');
    showToast('Failed to send response', 'error');
  }
}

function respondToPrompt(response) {
  const card = document.getElementById('promptCard');
  card.classList.add('loading');

  // Haptic feedback
  navigator.vibrate?.(50);

  // Send response
  const success = wsSend({ action: 'inject', command: response, sessionId: currentSessionId });

  if (success) {
    trackSentMessage(response);
    appendMessage({ type: 'user', content: response });
    if (settings.ttsEnabled) {
      speak(`Sent: ${response}`);
    }
    setTimeout(() => hidePromptCard(), 300);
  } else {
    card.classList.remove('loading');
    showToast('Failed to send response', 'error');
  }
}

function respondToPromptFreeform() {
  const input = document.getElementById('promptFreeformInput');
  const text = input?.value?.trim();
  if (!text) {
    showToast('Please enter a response', 'error');
    return;
  }

  // For structured prompts (AskUserQuestion), use select_other
  // "Other" is the last option, appended by Claude Code after all defined options
  if (currentPrompt?.isStructured) {
    const otherIndex = currentPrompt.options?.length || 0;
    const card = document.getElementById('promptCard');
    card.classList.add('loading');
    navigator.vibrate?.(50);
    const success = wsSend({ action: 'select_other', sessionId: currentSessionId, index: otherIndex, text });
    if (success) {
      trackSentMessage(text);
      appendMessage({ type: 'user', content: text });
      if (settings.ttsEnabled) speak(`Sent: ${text}`);
      setTimeout(() => hidePromptCard(), 300);
    } else {
      card.classList.remove('loading');
      showToast('Failed to send response', 'error');
    }
  } else {
    // Non-structured prompts: inject text directly
    respondToPrompt(text);
  }
}

function selectOption(el, isMulti = false) {
  if (isMulti) {
    // Toggle selection for multi-select
    const isSelected = el.classList.toggle('selected');
    el.setAttribute('aria-checked', isSelected ? 'true' : 'false');
    // Update checkbox visual
    const span = el.querySelector('span');
    if (span) {
      span.textContent = span.textContent.replace(/^[☐☑] /, isSelected ? '☑ ' : '☐ ');
    }
  } else {
    // Single select - toggle if clicking same option, otherwise switch
    const wasSelected = el.classList.contains('selected');
    document.querySelectorAll('.prompt-option').forEach(o => {
      o.classList.remove('selected');
      o.setAttribute('aria-checked', 'false');
    });
    if (!wasSelected) {
      el.classList.add('selected');
      el.setAttribute('aria-checked', 'true');
    }
    // If wasSelected, clicking again deselects it (allows freeform input)
  }
}

async function submitChoice(isMulti = false) {
  const selected = document.querySelectorAll('.prompt-option.selected');
  if (selected.length > 0) {
    const card = document.getElementById('promptCard');
    card.classList.add('loading');
    navigator.vibrate?.(50);

    // For structured prompts (AskUserQuestion), use select_option server action
    if (currentPrompt?.isStructured) {
      if (isMulti && selected.length > 1) {
        // Multi-select: send each selection as select_option sequentially
        const indices = Array.from(selected).map(el => parseInt(el.dataset.value, 10) - 1);
        try {
          for (let i = 0; i < indices.length; i++) {
            showToast(`Selecting option ${indices[i] + 1}...`, 'info');
            const success = wsSend({ action: 'select_option', sessionId: currentSessionId, index: indices[i] });
            if (!success) throw new Error('WebSocket send failed');
            await new Promise(r => setTimeout(r, 1000));
          }
          // Final Enter to confirm multi-select (send select_option with current position)
          showToast('Confirming...', 'info');
          wsSend({ action: 'inject', command: '', sessionId: currentSessionId });
          appendMessage({ type: 'user', content: indices.map(i => i + 1).join(', ') });
          hidePromptCard();
        } catch (e) {
          console.error('Multi-select failed:', e);
          showToast('Multi-select failed: ' + e.message, 'error');
          card.classList.remove('loading');
        }
      } else {
        // Single select: send select_option with 0-based index
        const index = parseInt(selected[0].dataset.value, 10) - 1;
        const success = wsSend({ action: 'select_option', sessionId: currentSessionId, index });
        if (success) {
          trackSentMessage(selected[0].dataset.value);
          appendMessage({ type: 'user', content: selected[0].dataset.value });
          if (settings.ttsEnabled) speak(`Selected option ${selected[0].dataset.value}`);
          setTimeout(() => hidePromptCard(), 300);
        } else {
          card.classList.remove('loading');
          showToast('Failed to send response', 'error');
        }
      }
    } else {
      // Non-structured (detected) prompts: use inject as before
      card.classList.remove('loading');
      if (isMulti && selected.length > 1) {
        card.classList.add('loading');
        const values = Array.from(selected).map(el => el.dataset.value);
        try {
          for (let i = 0; i < values.length; i++) {
            showToast(`Selecting option ${values[i]}...`, 'info');
            await injectAndWait(values[i]);
            await new Promise(r => setTimeout(r, 1000));
          }
          showToast('Submitting...', 'info');
          await injectAndWait('');
          appendMessage({ type: 'user', content: values.join(', ') });
          hidePromptCard();
        } catch (e) {
          console.error('Multi-select failed:', e);
          showToast('Multi-select failed: ' + e.message, 'error');
          card.classList.remove('loading');
        }
      } else {
        respondToPrompt(selected[0].dataset.value);
      }
    }
  } else {
    showToast('Please select an option', 'error');
  }
}

function submitDropdownChoice() {
  const select = document.getElementById('promptSelect');
  if (select?.value) {
    respondToPrompt(select.value);
  } else {
    showToast('Please select an option', 'error');
  }
}

function submitFreeform() {
  const input = document.getElementById('promptInput');
  if (input?.value.trim()) {
    respondToPrompt(input.value.trim());
  } else {
    showToast('Please enter a response', 'error');
  }
}

function hidePromptCard() {
  const card = document.getElementById('promptCard');
  card.classList.remove('show', 'loading', 'stale');
  currentPrompt = null;
  lastRespondedAt = Date.now(); // Suppress fallback flash after response
  updateActionButtons();
  updatePromptQueueBadge();
  checkFallbackApproval();

  // Show next queued prompt if any
  if (promptQueue.length > 0) {
    const next = promptQueue.shift();
    // Small delay so the card animates out before showing the next one
    setTimeout(() => showPromptCard(next), 350);
  }
}

function updatePromptQueueBadge() {
  let badge = document.getElementById('promptQueueBadge');
  if (!badge) {
    badge = document.createElement('div');
    badge.id = 'promptQueueBadge';
    badge.className = 'prompt-queue-badge';
    document.getElementById('promptCard').appendChild(badge);
  }
  if (promptQueue.length > 0) {
    badge.textContent = `+${promptQueue.length} more`;
    badge.style.display = '';
  } else {
    badge.style.display = 'none';
  }
}

function dismissPrompt() {
  // Minimize prompt instead of sending denial (matches iOS: dismiss = hide, not reject)
  if (currentPrompt) {
    minimizedPrompts.push(currentPrompt);
  }
  // Hide card without sending any response to server
  const card = document.getElementById('promptCard');
  card.classList.remove('show', 'loading', 'stale');
  currentPrompt = null;
  updateActionButtons();
  updatePromptQueueBadge();
  updateMinimizedIndicator();
  checkFallbackApproval();

  // Show next queued prompt if any
  if (promptQueue.length > 0) {
    const next = promptQueue.shift();
    setTimeout(() => showPromptCard(next), 350);
  }

  showToast('Prompt minimized', 'info');
}

function restoreMinimizedPrompts() {
  if (minimizedPrompts.length === 0) return;
  // Move all minimized prompts back to the queue
  promptQueue.push(...minimizedPrompts);
  minimizedPrompts.length = 0;
  updateMinimizedIndicator();
  // Show the first one if nothing is currently showing
  if (!currentPrompt && promptQueue.length > 0) {
    const next = promptQueue.shift();
    showPromptCard(next);
  }
}

function updateMinimizedIndicator() {
  let indicator = document.getElementById('minimizedPromptIndicator');
  if (minimizedPrompts.length > 0) {
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.id = 'minimizedPromptIndicator';
      indicator.className = 'minimized-prompt-indicator';
      indicator.onclick = restoreMinimizedPrompts;
      // Insert before the fallback approval row in input-area
      const fallback = document.getElementById('fallbackApproval');
      fallback.parentNode.insertBefore(indicator, fallback);
    }
    const count = minimizedPrompts.length;
    indicator.innerHTML = `<span class="minimized-icon">&#9776;</span> ${count} minimized prompt${count === 1 ? '' : 's'} <span class="minimized-restore">Restore</span>`;
    indicator.style.display = '';
  } else if (indicator) {
    indicator.style.display = 'none';
  }
}

function checkPromptStaleness() {
  if (!currentPrompt) return;
  const currentCount = document.querySelectorAll('.message').length;
  const messagesSince = currentCount - promptMessageIndex;

  if (messagesSince > 2) {
    document.getElementById('promptCard').classList.add('stale');
  }

  // Auto-remove stale permissions after 30+ messages (send denial to prevent deadlock)
  if (messagesSince >= 30 && currentPrompt.type === 'permission') {
    if (currentPrompt.toolUseId) {
      wsSend({ action: 'inject', command: 'n', sessionId: currentSessionId, toolUseId: currentPrompt.toolUseId });
    }
    hidePromptCard();
  }
}

// ============================================
// Fallback Approval (when prompt card fails)
// ============================================

function getCurrentSessionStatus() {
  if (!currentSessionId) return null;
  const option = document.querySelector(`#sessionSelector option[value="${CSS.escape(currentSessionId)}"]`);
  return option?.dataset.status || null;
}

function checkFallbackApproval() {
  const isWaiting = getCurrentSessionStatus() === 'waiting';
  const hasPrompt = currentPrompt !== null;

  // Suppress fallback for 3 seconds after responding to a prompt (prevents flash)
  const recentlyResponded = lastRespondedAt > 0 && (Date.now() - lastRespondedAt) < 3000;

  if (isWaiting && !hasPrompt && currentSessionId && !recentlyResponded) {
    // Start 2s timer if not already running
    if (!fallbackApprovalTimer) {
      fallbackApprovalTimer = setTimeout(() => {
        const el = document.getElementById('fallbackApproval');
        if (el) el.classList.remove('hidden');
        fallbackApprovalTimer = null;
      }, FALLBACK_DEBOUNCE_MS);
    }
  } else {
    hideFallbackApproval();
  }
}

function hideFallbackApproval() {
  if (fallbackApprovalTimer) {
    clearTimeout(fallbackApprovalTimer);
    fallbackApprovalTimer = null;
  }
  const el = document.getElementById('fallbackApproval');
  if (el) el.classList.add('hidden');
}

function fallbackApprove(command) {
  if (!currentSessionId) return;
  if (!VALID_APPROVAL_COMMANDS.includes(command)) return;
  navigator.vibrate?.(50);
  const success = wsSend({ action: 'inject', command, sessionId: currentSessionId });
  if (success) {
    trackSentMessage(command);
    appendMessage({ type: 'user', content: command });
    hideFallbackApproval();
  }
}
