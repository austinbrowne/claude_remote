---
status: complete
priority: p1
issue_id: "028"
tags:
  - security
  - code-review
  - supply-chain
dependencies: []
---

# CDN Dependency Without Subresource Integrity

## Problem Statement

Prism.js is loaded from cdnjs.cloudflare.com without Subresource Integrity (SRI) hashes. If the CDN is compromised, malicious code could be injected and executed in users' browsers.

**Why it matters**: Supply chain attacks via CDN compromise are a documented attack vector. Without SRI, any compromise of cdnjs would allow arbitrary code execution.

## Findings

**CDN Resources Without SRI:**

```html
<!-- Line 12 -->
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism-tomorrow.min.css" ...>
```

```javascript
// Lines 2344-2354
script.src = 'https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/prism.min.js';
langScript.src = `https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-${lang}.min.js`;
```

**Issues:**
1. No `integrity` attribute on any CDN resource
2. Dynamic language component loading increases attack surface
3. No Content Security Policy to restrict script sources

## Proposed Solutions

### Option A: Add SRI hashes (Recommended)
- Calculate and add integrity hashes to all CDN resources
- Add crossorigin="anonymous" attribute
- **Pros**: Quick fix, maintains CDN benefits
- **Cons**: Dynamic language loading harder to secure
- **Effort**: Low
- **Risk**: Low

### Option B: Self-host Prism.js
- Download and serve Prism locally from /public
- Bundle needed languages
- **Pros**: Complete control, no external dependency
- **Cons**: Larger repo, manual updates needed
- **Effort**: Medium
- **Risk**: Low

### Option C: Remove syntax highlighting
- YAGNI - feature may not be essential
- **Pros**: Eliminates risk entirely, simplifies code
- **Cons**: Less feature-rich
- **Effort**: Low
- **Risk**: None

## Recommended Action

Option B (self-host) if syntax highlighting is needed, otherwise Option C.

## Technical Details

**Affected files:**
- `public/index.html:12` - CSS link
- `public/index.html:2344-2354` - Script loading

**SRI hashes for Prism 1.29.0:**
```html
<script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/prism.min.js"
        integrity="sha512-7Z9J3l1+EYfeaPKcGXu3MS/7T+w19WtKQY/n+xzmw4hZhJ9tyYmcUS+4QqAlzhicE5LAfMQSF3iFTk5PS/DGbg=="
        crossorigin="anonymous"></script>
```

## Acceptance Criteria

- [ ] All external scripts have SRI hashes OR are self-hosted
- [ ] crossorigin="anonymous" added to CDN resources
- [ ] CSP header restricts script sources
- [ ] Tested that syntax highlighting still works

## Work Log

| Date | Action | Notes |
|------|--------|-------|
| 2026-01-26 | Created | Identified during security-focused code review |

## Resources

- https://developer.mozilla.org/en-US/docs/Web/Security/Subresource_Integrity
- https://www.srihash.org/ - SRI hash generator
