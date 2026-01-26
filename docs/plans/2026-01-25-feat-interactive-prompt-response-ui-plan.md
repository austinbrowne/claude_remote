---
title: Interactive Prompt Response UI
type: feat
date: 2026-01-25
---

# Interactive Prompt Response UI

## Overview

Add a clean visual and voice interface to respond when Claude needs:
- Permission to run commands
- User to pick from options
- Yes/No confirmations
- Free-form feedback

## Problem Statement

Currently, when Claude asks a question or needs permission, the user must:
1. Read the scrolling output to notice the prompt
2. Manually type a response in the text input
3. No voice-friendly way to respond

This is clunky on mobile and breaks the hands-free voice workflow.

## Proposed Solution

### 1. Prompt Detection (Parse Claude's Output)

Detect common prompt patterns in the **last portion** of assistant messages to avoid false positives:

```javascript
// prompt-detector.js patterns
const PROMPT_PATTERNS = {
  permission: [
    /\(y\/n\)/i,
    /\[y\/n\]/i,
    /\[yes\/no\]/i,
    /proceed\?/i,
    /continue\?/i,
    /allow this\?/i,
    /run this command\?/i,
    /approve|reject/i,
    /is that okay\?/i,
  ],
  multiChoice: [
    /^(\d+)[.)]\s+(.+)$/gm,         // "1. Option" or "1) Option"
    /^([A-D])[.)]\s+(.+)$/gim,      // "A. Option" or "A) Option"
  ],
  yesNo: [
    /\(yes\/no\)/i,
    /yes or no/i,
    /should I/i,
    /want me to/i,
    /shall I/i,
    /do you want/i,
  ],
  freeForm: [
    /what would you like/i,
    /please describe/i,
    /tell me more/i,
    /any feedback/i,
    /your thoughts/i,
  ]
};

// Destructive keywords - swap button styling
const DESTRUCTIVE_KEYWORDS = [
  'delete', 'remove', 'drop', 'destroy', 'reset', 'force', 'overwrite', 'erase'
];
```

### 2. Interactive Response Card

When a prompt is detected, show a card UI that adapts to keyboard/viewport:

**Permission prompt (with command preview):**
```
┌─────────────────────────────────────┐
│ ⚠️ Permission Required              │
├─────────────────────────────────────┤
│ Can I run this command?             │
│ ┌─────────────────────────────────┐ │
│ │ npm install express             │ │
│ └─────────────────────────────────┘ │
│                                     │
│  ┌─────────┐  ┌─────────┐          │
│  │   Yes   │  │   No    │          │
│  └─────────┘  └─────────┘          │
└─────────────────────────────────────┘
```

**Multiple choice (scrollable for 5+ options):**
```
┌─────────────────────────────────────┐
│ 📋 Pick an option                   │
├─────────────────────────────────────┤
│ ┌─────────────────────────────────┐ │
│ │ ● Option 1: Use Redis cache     │ │
│ │ ○ Option 2: Use in-memory cache │ │
│ │ ○ Option 3: Skip caching        │ │
│ └─────────────────────────────────┘ │
│                                     │
│  ┌───────────────────────┐          │
│  │      Select (1)       │          │
│  └───────────────────────┘          │
└─────────────────────────────────────┘
```

### 3. Voice Integration

**When TTS is enabled:**
1. Read the prompt aloud: "Claude is asking: Can I run npm install express?"
2. Disable STT during TTS playback (prevent feedback loop)
3. After TTS completes + 500ms delay, auto-enable listening
4. Map voice responses to actions:
   - "yes/yeah/yep/okay/proceed" → Yes button
   - "no/nope/cancel/stop" → No button
   - "option one/1/first" → Select option 1
   - Free text → Submit as free-form response

**When TTS is disabled:**
1. Send push notification: "Claude needs input"
2. Show visual card when user opens app

### 4. Response Flow

```
Claude output received
        │
        ▼
  Detect prompt in LAST portion of message
  (avoid false positives from explanations)
        │
   ┌────┴────┐
   │ Prompt? │
   └────┬────┘
    No  │  Yes
    │   │
    ▼   ▼
 Normal  Show response card
 display      │
              ├─► Permission: Yes/No (color-coded by destructiveness)
              ├─► Multi-choice: Radio options (dropdown if 5+)
              ├─► Yes/No: Yes/No buttons
              └─► Free-form: Text input + Submit
                      │
                      ▼
              User responds (tap, voice, or keyboard)
                      │
                      ▼
              Show loading state
                      │
                      ▼
              Inject response via WebSocket
                      │
                      ▼
              Haptic feedback + optional voice confirmation
                      │
                      ▼
              Hide card, continue normal flow
```

### 5. Staleness Handling

Track the message index when showing a prompt card. If new messages arrive:
- Auto-dismiss the card after 2 new messages
- Or show "This prompt may be stale" indicator
- User can still respond, but with visual warning

## Technical Approach

### Files to Modify

| File | Changes |
|------|---------|
| `public/index.html` | Add prompt card HTML, CSS, detection logic, voice input |

### Implementation

#### Step 1: Add Prompt Card HTML/CSS

```html
<!-- public/index.html - after output-area -->
<div class="prompt-card" id="promptCard"
     role="alertdialog"
     aria-labelledby="promptTitle"
     aria-describedby="promptContent"
     aria-modal="true">
  <div class="prompt-header">
    <span class="prompt-icon" id="promptIcon">🔔</span>
    <span class="prompt-title" id="promptTitle">Claude needs input</span>
    <button class="prompt-dismiss" onclick="dismissPrompt()" aria-label="Respond later">✕</button>
  </div>
  <div class="prompt-content" id="promptContent"></div>
  <div class="prompt-actions" id="promptActions"></div>
  <div class="prompt-loading" id="promptLoading">Sending...</div>
  <div class="prompt-stale" id="promptStale">⚠️ Claude may have moved on</div>
</div>
```

```css
.prompt-card {
  position: fixed;
  bottom: 180px;
  left: 12px;
  right: 12px;
  background: var(--bg-secondary);
  border: 2px solid var(--accent);
  border-radius: 16px;
  padding: 16px;
  display: none;
  z-index: 50;
  animation: slideUp 0.3s ease;
  max-height: 60vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.prompt-card.show { display: flex; }
.prompt-card.permission { border-color: var(--warning); }
.prompt-card.destructive { border-color: var(--error); }

@media (prefers-reduced-motion: reduce) {
  .prompt-card { animation: none; }
}

@keyframes slideUp {
  from { transform: translateY(20px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}

.prompt-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
  flex-shrink: 0;
}

.prompt-title {
  flex: 1;
  font-weight: 600;
}

.prompt-dismiss {
  background: transparent;
  border: none;
  color: var(--text-muted);
  font-size: 1.2rem;
  cursor: pointer;
  padding: 4px 8px;
}

.prompt-content {
  max-height: 150px;
  overflow-y: auto;
  margin-bottom: 12px;
  flex-shrink: 1;
}

.prompt-content p {
  margin: 0 0 8px 0;
  line-height: 1.4;
}

.prompt-command-preview {
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 12px;
  font-family: 'SF Mono', monospace;
  font-size: 0.85rem;
  margin: 8px 0;
  overflow-x: auto;
}

.prompt-actions {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  flex-shrink: 0;
}

.prompt-btn {
  flex: 1;
  min-width: 100px;
  min-height: 56px;
  padding: 16px 24px;
  border-radius: 12px;
  font-size: 1rem;
  font-weight: 600;
  cursor: pointer;
  border: none;
  transition: transform 0.1s, opacity 0.1s;
}
.prompt-btn:active {
  transform: scale(0.97);
}
.prompt-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.prompt-btn.primary {
  background: var(--success);
  color: white;
}
.prompt-btn.primary.destructive {
  background: var(--error);
}

.prompt-btn.secondary {
  background: var(--bg-tertiary);
  color: var(--text-primary);
  border: 1px solid var(--border);
}

.prompt-options-scroll {
  max-height: 200px;
  overflow-y: auto;
  margin-bottom: 12px;
}

.prompt-option {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  margin-bottom: 8px;
  cursor: pointer;
  min-height: 48px;
}
.prompt-option:focus {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.prompt-option.selected {
  border-color: var(--accent);
  background: rgba(88, 166, 255, 0.15);
}

.prompt-option input[type="radio"] {
  display: none;
}
.prompt-option::before {
  content: '';
  width: 24px;
  height: 24px;
  border: 2px solid var(--border);
  border-radius: 50%;
  flex-shrink: 0;
}
.prompt-option.selected::before {
  background: var(--accent);
  border-color: var(--accent);
  box-shadow: inset 0 0 0 4px var(--bg-secondary);
}

.prompt-input {
  width: 100%;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  color: var(--text-primary);
  font-size: 1rem;
  resize: none;
  margin-bottom: 12px;
}
.prompt-input:focus {
  border-color: var(--accent);
  outline: none;
}

.prompt-loading,
.prompt-stale {
  display: none;
  text-align: center;
  padding: 8px;
  font-size: 0.85rem;
  color: var(--text-muted);
}
.prompt-card.loading .prompt-loading { display: block; }
.prompt-card.loading .prompt-actions { opacity: 0.5; pointer-events: none; }
.prompt-card.stale .prompt-stale { display: block; }
```

#### Step 2: Prompt Detection Logic

```javascript
// Add to public/index.html <script>

const PROMPT_STYLES = {
  permission: { icon: '⚠️', title: 'Permission Required', className: 'permission' },
  yesNo: { icon: '❓', title: 'Question', className: '' },
  multiChoice: { icon: '📋', title: 'Pick an option', className: '' },
  freeForm: { icon: '✏️', title: 'Your input needed', className: '' }
};

const DESTRUCTIVE_KEYWORDS = ['delete', 'remove', 'drop', 'destroy', 'reset', 'force', 'overwrite', 'erase'];

let currentPrompt = null;
let promptMessageIndex = 0;

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

function showPromptCard(prompt) {
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
      content.innerHTML = `<p>${escapeHtml(question)}</p>`;
      if (prompt.command) {
        content.innerHTML += `<div class="prompt-command-preview"><code>${escapeHtml(prompt.command)}</code></div>`;
      }
      const yesClass = prompt.isDestructive ? 'secondary' : 'primary';
      const noClass = prompt.isDestructive ? 'primary destructive' : 'secondary';
      actions.innerHTML = `
        <button class="prompt-btn ${yesClass}" onclick="respondToPrompt('y')">Yes</button>
        <button class="prompt-btn ${noClass}" onclick="respondToPrompt('n')">No</button>
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
      content.innerHTML = `<p>${escapeHtml(question)}</p>`;
      const useDropdown = prompt.options.length > 5;
      if (useDropdown) {
        content.innerHTML += `
          <select class="prompt-select" id="promptSelect">
            <option value="">Select an option...</option>
            ${prompt.options.map(opt => `<option value="${opt.num}">${escapeHtml(opt.num)}. ${escapeHtml(opt.text)}</option>`).join('')}
          </select>
        `;
        actions.innerHTML = `<button class="prompt-btn primary" onclick="submitDropdownChoice()">Select</button>`;
      } else {
        content.innerHTML += `<div class="prompt-options-scroll">
          ${prompt.options.map((opt, i) => `
            <div class="prompt-option" data-value="${opt.num}" onclick="selectOption(this)" tabindex="0" role="radio" aria-checked="false">
              <span>${escapeHtml(opt.num)}. ${escapeHtml(opt.text)}</span>
            </div>
          `).join('')}
        </div>`;
        actions.innerHTML = `<button class="prompt-btn primary" onclick="submitChoice()">Select</button>`;
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
      selectOption(options[next]);
      options[next].focus();
    } else if (e.key === 'Enter' && document.activeElement?.classList.contains('prompt-option')) {
      e.preventDefault();
      submitChoice();
    }
  };
}

function respondToPrompt(response) {
  const card = document.getElementById('promptCard');
  card.classList.add('loading');

  // Haptic feedback
  navigator.vibrate?.(50);

  // Send response
  const success = wsSend({ action: 'inject', command: response });

  if (success) {
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

function selectOption(el) {
  document.querySelectorAll('.prompt-option').forEach(o => {
    o.classList.remove('selected');
    o.setAttribute('aria-checked', 'false');
  });
  el.classList.add('selected');
  el.setAttribute('aria-checked', 'true');
}

function submitChoice() {
  const selected = document.querySelector('.prompt-option.selected');
  if (selected) {
    respondToPrompt(selected.dataset.value);
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
```

#### Step 3: Voice Input for Responses

```javascript
// Add voice response handling
function speakThenListen(text) {
  if (!settings.ttsEnabled || !synth) return;

  // Stop any current listening
  if (recognition && isRecording) {
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
    // Wait 500ms then start listening for response
    setTimeout(() => {
      if (currentPrompt && recognition) {
        startListeningForPromptResponse();
      }
    }, 500);
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
  if (['no', 'nope', 'cancel', 'stop', 'don\'t', 'abort', 'negative'].includes(text)) {
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

// Modify existing speech recognition handler to check for prompt responses
// In initSpeechRecognition(), update the onresult handler:
// if (currentPrompt && handleVoicePromptResponse(finalTranscript)) return;
```

#### Step 4: Hook into Message Flow

```javascript
// Modify appendMessage() to detect prompts and check staleness
function appendMessage(data, scroll = true) {
  // ... existing code to create and append message ...

  // Check for staleness of existing prompt
  checkPromptStaleness();

  // After appending, check if this is a new prompt
  if (data.type === 'assistant') {
    const prompt = detectPromptType(data.content);
    if (prompt) {
      showPromptCard(prompt);
    }
  }

  return msg;
}
```

#### Step 5: Viewport Handling for Keyboard

```javascript
// Handle keyboard appearance on mobile
function setupViewportHandling() {
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', adjustPromptCardPosition);
  }
}

function adjustPromptCardPosition() {
  const card = document.getElementById('promptCard');
  if (!card.classList.contains('show')) return;

  const viewport = window.visualViewport;
  if (viewport) {
    const keyboardHeight = window.innerHeight - viewport.height;
    if (keyboardHeight > 100) {
      // Keyboard is visible
      card.style.bottom = (keyboardHeight + 10) + 'px';
    } else {
      card.style.bottom = '180px';
    }
  }
}

// Call on init
document.addEventListener('DOMContentLoaded', setupViewportHandling);
```

## Acceptance Criteria

- [x] Permission prompts (y/n) show Yes/No buttons with command preview
- [x] Destructive prompts swap button colors (No is primary/red)
- [x] Multiple choice prompts show selectable options (dropdown if 5+)
- [x] Yes/No prompts show Yes/No buttons
- [x] Free-form prompts show text input with focus
- [x] Tapping a button shows loading state, then injects response
- [x] With TTS on, prompts are read aloud, then mic activates
- [x] Voice responses ("yes", "no", "option 1") are recognized
- [x] Card repositions when keyboard appears
- [x] Card shows "stale" warning if 2+ new messages arrive
- [x] Card can be dismissed with "respond later" toast
- [x] Haptic feedback on button press
- [x] ARIA roles and keyboard navigation work
- [x] Reduced motion respected

## Success Metrics

- Faster response time to Claude prompts (< 2 seconds vs typing)
- Fewer typos in responses (0 with buttons)
- Usable in true hands-free voice mode
- Accessibility audit passes

## References

- Existing TTS: `public/index.html:1190-1210`
- Existing STT: `public/index.html:758-800`
- Message parsing: `public/index.html:1031-1066`
- WebSocket inject: `server.js:550-555`
- Apple HIG touch targets: 44x44pt minimum
- Material Design: 48x48dp minimum
