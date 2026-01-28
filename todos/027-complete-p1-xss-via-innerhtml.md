---
status: complete
priority: p1
issue_id: "027"
tags:
  - security
  - code-review
  - xss
dependencies: []
---

# XSS Vulnerability via innerHTML Template Literals

## Problem Statement

Multiple locations in `public/index.html` use `innerHTML` with template literals that could allow XSS attacks. The `lang` variable is inserted into onclick handlers without escaping, and Prism.js output is inserted directly into the DOM.

**Why it matters**: A malicious log entry or crafted input could inject JavaScript, compromising the user's session and potentially the entire system via command injection.

## Findings

**Finding 1: Tool Input Rendering (Lines 1549-1556)**
```javascript
msg.innerHTML = `
  <div class="tool-summary" onclick="toggleToolExpand(this.parentElement, '${lang}')">
```
The `lang` variable from `detectLanguage()` is inserted into onclick without escaping.

**Finding 2: Prism.js Output (Line 2390)**
```javascript
preElement.innerHTML = Prism.highlight(code, grammar, language);
```
Prism output inserted directly - if Prism has vulnerabilities, XSS is possible.

**Finding 3: Autocomplete Rendering (Lines 1753-1758)**
```javascript
autocomplete.innerHTML = matches.map((m, i) => `
  <div onclick="selectAutocomplete('${m.cmd}')">
```
`m.cmd` inserted into onclick handlers.

## Proposed Solutions

### Option A: Use data attributes + event delegation (Recommended)
- Replace inline onclick with data attributes
- Use single delegated event listener
- **Pros**: Eliminates injection vectors, cleaner code
- **Cons**: Requires refactoring event handling
- **Effort**: Medium
- **Risk**: Low

### Option B: Strict escaping for HTML attributes
- Create `escapeAttr()` function for attribute contexts
- Apply to all dynamic values in attributes
- **Pros**: Minimal code change
- **Cons**: Easy to miss spots, ongoing maintenance
- **Effort**: Low
- **Risk**: Medium (may miss cases)

### Option C: Use textContent + createElement
- Replace innerHTML with DOM construction
- **Pros**: Most secure, no HTML parsing
- **Cons**: More verbose code
- **Effort**: High
- **Risk**: Low

## Recommended Action

Option A - Use data attributes and event delegation.

## Technical Details

**Affected files:**
- `public/index.html:1549-1556` - tool rendering
- `public/index.html:2390` - Prism highlighting
- `public/index.html:1753-1758` - autocomplete

## Acceptance Criteria

- [ ] No dynamic values interpolated into onclick/event handlers
- [ ] Data attributes used for passing data to event handlers
- [ ] Event delegation pattern implemented
- [ ] Tested with malicious payloads in log entries

## Work Log

| Date | Action | Notes |
|------|--------|-------|
| 2026-01-26 | Created | Identified during security-focused code review |

## Resources

- OWASP XSS Prevention Cheat Sheet
- Security review agent finding
