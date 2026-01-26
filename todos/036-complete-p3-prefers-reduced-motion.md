---
status: complete
priority: p3
issue_id: "036"
tags:
  - accessibility
  - code-review
  - css
dependencies: []
---

# Reconnection Animation Ignores prefers-reduced-motion

## Problem Statement

The pulsing yellow dot animation for reconnection status runs infinitely and doesn't respect the `prefers-reduced-motion` media query.

**Why it matters**: Users with vestibular disorders or motion sensitivity should have animations disabled. Also reduces battery drain for users who prefer reduced motion.

## Findings

**Location:** `/Users/austin/Git_Repos/claude_remote/public/index.html` lines 17-21

```css
.status-dot.reconnecting {
  background: var(--warning);
  animation: pulse 1s infinite;
}
```

No `@media (prefers-reduced-motion: reduce)` query to disable animation.

## Proposed Solutions

### Option A: Add reduced-motion query (Recommended)
```css
@media (prefers-reduced-motion: reduce) {
  .status-dot.reconnecting {
    animation: none;
  }
}
```
- **Pros**: Respects user preferences, simple fix
- **Cons**: None
- **Effort**: Trivial
- **Risk**: None

## Recommended Action

Option A - Add prefers-reduced-motion media query.

## Technical Details

**Affected files:**
- `public/index.html:17-21` - reconnecting animation

## Acceptance Criteria

- [x] Animation disabled when prefers-reduced-motion is set
- [x] Yellow color still visible (just not pulsing)
- [x] Tested with system motion settings

## Work Log

| Date | Action | Notes |
|------|--------|-------|
| 2026-01-26 | Created | Identified during performance review |

## Resources

- https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion
- Performance oracle agent finding
