---
title: "XSS via Inline onclick Handlers with Unescaped Dynamic Values"
category: code-quality
subcategory: security
tags:
  - xss
  - security
  - inline-handlers
  - escaping
  - javascript
  - web-client
components:
  - prompts.js:showPromptCard
symptoms:
  - arbitrary-js-execution
  - broken-onclick-handlers
root_causes:
  - string-interpolation-in-onclick-attribute
  - escapeHtml-doesnt-escape-single-quotes
severity: critical
date_solved: 2026-02-08
---

# XSS via Inline onclick Handlers with Unescaped Dynamic Values

## Problem

Dynamic values (tool names) interpolated directly into `onclick` attribute strings using template literals. A tool name containing a single quote breaks out of the JS string literal, enabling arbitrary JavaScript execution.

```javascript
// VULNERABLE: tool name injected raw into onclick
onclick="respondToPermission('2', '${toolName}')"

// Attack: toolName = "Bash'); alert(document.cookie)//"
// Produces: onclick="respondToPermission('2', 'Bash'); alert(document.cookie)//')"
```

### Why escapeHtml is insufficient

The common `escapeHtml()` function escapes `&`, `<`, `>`, `"` but does NOT escape single quotes (`'`). Since the onclick attribute uses single quotes for the JS string delimiter, `escapeHtml` provides zero protection here.

## Solution

Use `JSON.stringify()` which properly escapes all special characters including quotes, backslashes, and Unicode:

```javascript
const safeTool = JSON.stringify(toolName);
// Produces: onclick="respondToPermission('2', \"Bash\")"
// JSON.stringify wraps in double quotes and escapes all internals

actions.innerHTML = `
  <button onclick="respondToPermission('2', ${safeTool})">Always Allow</button>
`;
```

Even better: use `addEventListener` instead of inline handlers entirely. But when inline handlers are the existing pattern, `JSON.stringify` is the correct escape function for JavaScript string values in HTML attributes.

## Key Gotchas

1. **`escapeHtml` is for HTML content, not JS-in-HTML.** It escapes HTML entities but not JavaScript string delimiters. Never use it for values inside `onclick`, `onchange`, etc.

2. **Single-quoted JS strings in double-quoted HTML attributes.** The common pattern `onclick="fn('${val}')"` has two escape contexts: HTML attribute (double quotes) and JS string (single quotes). `escapeHtml` handles the outer context but not the inner one.

3. **MCP tool names contain special characters.** Tool names like `WebFetch(domain:x.com)` have parentheses. Custom MCP tools may have arbitrary names. Never assume tool names are alphanumeric.

4. **`JSON.stringify` handles both contexts.** It produces a double-quoted string with all special chars escaped. When placed in an HTML attribute, the quotes become `&quot;` in the rendered HTML, but the browser correctly parses both layers.

## Prevention

- Grep for `onclick=".*\$\{` — any template literal inside an onclick is suspect
- Prefer `addEventListener` over inline handlers for dynamic values
- When inline handlers are unavoidable, always use `JSON.stringify()` for JS string values
- Add to security review checklist: "Are any dynamic values interpolated into inline event handlers?"
