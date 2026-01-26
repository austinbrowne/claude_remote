---
title: Structured Prompt Detection (AskUserQuestion)
type: feat
date: 2026-01-25
---

# Structured Prompt Detection (AskUserQuestion)

## Problem Statement

Claude Code uses structured `AskUserQuestion` tool calls to present options to users. The current prompt detection only parses text patterns, missing these structured prompts entirely. Users on mobile can't respond to multi-choice questions that Claude presents.

Additionally, all prompt cards should include a freeform text input option, just like the terminal allows typing custom responses instead of selecting from options.

## JSONL Format for AskUserQuestion

```json
{
  "type": "assistant",
  "message": {
    "content": [
      { "type": "tool_use", "name": "AskUserQuestion", "input": {
        "questions": [{
          "question": "What would you like to do next?",
          "header": "Next step",
          "options": [
            { "label": "Option 1", "description": "Do thing 1" },
            { "label": "Option 2", "description": "Do thing 2" }
          ],
          "multiSelect": false
        }]
      }}
    ]
  }
}
```

## Proposed Solution

### 1. Parse AskUserQuestion in Server

Detect `AskUserQuestion` tool calls in the JSONL and emit them as a distinct message type.

### 2. Show Structured Prompts on Mobile

Display multi-choice cards with option buttons that send the option number (1, 2, 3...).

### 3. Add Freeform Text Input to All Prompts

Every prompt card (yes/no, multi-choice, structured) should have a text input at the bottom allowing users to type a custom response instead of selecting an option.

## Implementation

### server.js Changes

**Modify parseLogEntry to detect AskUserQuestion tool calls:**

```javascript
// In parseLogEntry, when processing assistant message content blocks:
if (Array.isArray(message.content)) {
  for (const block of message.content) {
    // ... existing tool_use handling ...

    // Detect AskUserQuestion tool calls
    if (block.type === 'tool_use' && block.name === 'AskUserQuestion') {
      results.push({
        type: 'ask_user_question',
        questions: block.input.questions,
        timestamp
      });
    }
  }
}
```

### public/index.html Changes

**Add CSS for freeform input in prompt cards:**

```css
.prompt-freeform {
  display: flex;
  gap: 8px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}

.prompt-freeform input {
  flex: 1;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-primary);
  color: var(--text-primary);
  font-size: 14px;
}

.prompt-freeform button {
  padding: 8px 16px;
  background: var(--accent);
  color: white;
  border: none;
  border-radius: 8px;
  font-weight: 500;
}
```

**Handle ask_user_question in handleMessage (inside existing claude_output case):**

```javascript
case 'claude_output':
  if (msg.sessionId === currentSessionId) {
    // Handle structured AskUserQuestion prompts
    if (msg.data.type === 'ask_user_question') {
      showStructuredPrompt(msg.data.questions);
      break;
    }
    // ... rest of existing handler (dedupe, appendMessage, TTS, etc.)
  }
  break;
```

**Add showStructuredPrompt function:**

```javascript
function showStructuredPrompt(questions) {
  // Defensive checks
  if (!Array.isArray(questions) || questions.length === 0) return;
  const q = questions[0];
  if (!q.question || !Array.isArray(q.options)) return;

  const prompt = {
    type: 'multiChoice',
    text: q.question,
    options: q.options.map((opt, i) => ({
      num: (i + 1).toString(),
      text: opt.description ? `${opt.label}: ${opt.description}` : opt.label
    }))
  };
  showPromptCard(prompt);
}
```

**Modify showPromptCard to include freeform input:**

```javascript
function showPromptCard(prompt) {
  const card = document.getElementById('promptCard');
  const content = document.getElementById('promptContent');

  let html = `<div class="prompt-text">${escapeHtml(prompt.text)}</div>`;

  if (prompt.type === 'yesNo') {
    html += `
      <div class="prompt-buttons">
        <button onclick="respondToPrompt('y')">Yes</button>
        <button onclick="respondToPrompt('n')">No</button>
      </div>
    `;
  } else if (prompt.type === 'multiChoice') {
    html += '<div class="prompt-options">';
    prompt.options.forEach(opt => {
      html += `<button class="prompt-option" onclick="respondToPrompt('${opt.num}')">${escapeHtml(opt.num)}. ${escapeHtml(opt.text)}</button>`;
    });
    html += '</div>';
  }

  // Add freeform input to ALL prompt types
  html += `
    <div class="prompt-freeform">
      <input type="text" id="promptFreeformInput" placeholder="Or type a custom response..."
             onkeydown="if(event.key==='Enter')respondToPromptFreeform()">
      <button onclick="respondToPromptFreeform()">Send</button>
    </div>
  `;

  content.innerHTML = html;
  card.classList.add('visible');
}

function respondToPromptFreeform() {
  const input = document.getElementById('promptFreeformInput');
  const text = input.value.trim();
  if (text) {
    respondToPrompt(text);
  }
}
```

## Acceptance Criteria

- [x] AskUserQuestion tool calls are parsed from JSONL
- [x] Structured prompts show as multi-choice cards on mobile
- [x] Selecting an option sends the option number (1, 2, 3...)
- [x] All prompt cards (yes/no, multi-choice, structured) have freeform text input
- [x] Pressing Enter in freeform input sends the response
- [x] Freeform input can override the button options
- [x] Empty/malformed questions handled gracefully (no errors)
- [x] Options without descriptions display label only

## Files to Modify

| File | Changes |
|------|---------|
| `server.js:~280` | Add AskUserQuestion detection in parseLogEntry |
| `public/index.html:~200` | Add CSS for prompt-freeform |
| `public/index.html:~880` | Handle ask_user_question in handleMessage |
| `public/index.html:~1320` | Add showStructuredPrompt function |
| `public/index.html:~1340` | Modify showPromptCard to include freeform input |
