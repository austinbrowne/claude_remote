// ============================================
// Interactive Prompt Response UI
// ============================================
const PROMPT_STYLES = {
  permission: { icon: '⚠️', title: 'Permission Required', className: 'permission' },
  yesNo: { icon: '❓', title: 'Question', className: '' },
  multiChoice: { icon: '📋', title: 'Pick an option', className: '' },
  freeForm: { icon: '✏️', title: 'Your input needed', className: '' }
};

const DESTRUCTIVE_KEYWORDS = ['delete', 'remove', 'drop', 'destroy', 'reset', 'force', 'overwrite', 'erase'];

let currentPrompt = null;
let promptMessageIndex = 0;
const promptQueue = [];

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

function showStructuredPrompt(questions, subagentId = null) {
  // Defensive checks
  if (!Array.isArray(questions) || questions.length === 0) return;
  const q = questions[0];
  if (!q.question || !Array.isArray(q.options)) return;

  const prompt = {
    type: 'multiChoice',
    text: q.question,
    multiSelect: q.multiSelect === true,  // Pass through multi-select flag
    subagentId: subagentId,               // Track which subagent needs response
    options: q.options.map((opt, i) => ({
      num: (i + 1).toString(),
      text: opt.description ? `${opt.label}: ${opt.description}` : opt.label
    }))
  };
  showPromptCard(prompt);
}

function showPromptCard(prompt) {
  // Queue if a prompt is already showing
  if (currentPrompt) {
    promptQueue.push(prompt);
    return;
  }

  const card = document.getElementById('promptCard');
  const content = document.getElementById('promptContent');
  const actions = document.getElementById('promptActions');
  const icon = document.getElementById('promptIcon');
  const title = document.getElementById('promptTitle');

  currentPrompt = prompt;
  promptMessageIndex = document.querySelectorAll('.message').length;

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
      actions.innerHTML = `
        <button class="prompt-btn ${prompt.isDestructive ? 'secondary' : 'primary'}" onclick="respondToPrompt('1')">Yes</button>
        <button class="prompt-btn allow-always" onclick="respondToPermission('2', '${prompt.tool || ''}')">Always Allow</button>
        <button class="prompt-btn ${prompt.isDestructive ? 'primary destructive' : 'secondary'}" onclick="respondToPrompt('3')">No</button>
      `;
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

// Track which tools have been "always allowed" (local tracking for UI only)
const alwaysAllowedTools = new Set();

// Handle permission response with tool tracking
function respondToPermission(response, tool) {
  if (response === '1' && tool) {
    alwaysAllowedTools.add(tool);
  }
  respondToPrompt(response);
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
  if (text) {
    respondToPrompt(text);
  } else {
    showToast('Please enter a response', 'error');
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
    if (isMulti && selected.length > 1) {
      // Multi-select: send each selection sequentially with long delays
      // Claude Code expects: type "1" Enter (toggle), type "3" Enter (toggle), Enter (submit)
      const card = document.getElementById('promptCard');
      card.classList.add('loading');
      navigator.vibrate?.(50);

      const values = Array.from(selected).map(el => el.dataset.value);
      try {
        for (let i = 0; i < values.length; i++) {
          showToast(`Selecting option ${values[i]}...`, 'info');
          await injectAndWait(values[i]);
          // Long delay to ensure terminal processes the keystroke
          await new Promise(r => setTimeout(r, 1000));
        }
        // Final empty Enter to submit selections
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
  updateActionButtons();

  // Show next queued prompt if any
  if (promptQueue.length > 0) {
    const next = promptQueue.shift();
    // Small delay so the card animates out before showing the next one
    setTimeout(() => showPromptCard(next), 350);
  }
}

function dismissPrompt() {
  hidePromptCard();
  showToast('You can still respond in the text input', 'info');
}

function checkPromptStaleness() {
  if (!currentPrompt) return;
  const currentCount = document.querySelectorAll('.message').length;
  if (currentCount > promptMessageIndex + 2) {
    document.getElementById('promptCard').classList.add('stale');
  }
}
