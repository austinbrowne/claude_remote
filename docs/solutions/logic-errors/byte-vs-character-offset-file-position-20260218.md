---
title: "Byte Offset vs Character Offset in File Position Tracking"
category: logic-errors
subcategory: encoding
tags:
  - utf8
  - file-io
  - byte-offset
  - character-offset
  - watcher
  - log-parsing
components:
  - lib/watcher.js
symptoms:
  - data-re-reading
  - data-skipping
  - corrupted-log-parsing
severity: high
date: 2026-02-18
---

# Byte Offset vs Character Offset in File Position Tracking

## Problem

In the subagent log watcher (`processFileContent`), file position was tracked using `String.lastIndexOf('\n')` — a character index. But the file was read at a byte offset via `fsp.open` + `fh.read`. For ASCII-only content, character index equals byte count. For multi-byte UTF-8 characters (emoji, accented characters, CJK text), the character index underestimates the byte count. This causes the next read to start at the wrong byte offset, re-reading already-processed bytes or skipping content.

## Root Cause

Two parallel implementations existed:
- `processLogChanges` (main session watcher) correctly used `Buffer.byteLength(completeContent + '\n', 'utf8')` for position tracking
- `processFileContent` (subagent watcher) used `lastNewlineIndex` (character index) for position tracking

The duplication meant the correct pattern existed but wasn't consistently applied.

## Fix

Replace character-based position tracking with byte-based:

```javascript
// WRONG: character offset
sessionData.subagentPositions.set(agentId, position + lastNewlineIndex + 1);

// RIGHT: byte offset
const consumedBytes = Buffer.byteLength(completeContent + '\n', 'utf8');
sessionData.subagentPositions.set(agentId, position + consumedBytes);
```

The `+ '\n'` accounts for the newline character that `completeContent` (via `substring`) excludes.

## Key Insight

**When reading files at byte offsets, always track position in bytes, not characters.** JavaScript strings are UTF-16, `String.length` and `String.indexOf` return character counts, but `fs.read` operates on byte offsets. The mismatch is invisible in ASCII-only content and only manifests with multi-byte characters.

## Prevention

- When tracking file positions for incremental reads, always use `Buffer.byteLength(content, 'utf8')` — never `String.length` or `String.indexOf`
- If two functions share the same file-reading pattern, extract a shared utility to ensure consistent byte handling
- Add a test with non-ASCII content (emoji or accented characters) to catch byte/character mismatches
- The adversarial validator caught this — no specialist reviewer flagged it

## Detection

This bug was found by the adversarial validator during fresh-eyes-review, not by any of the 6 specialist agents. The adversarial validator compared the two implementations and noticed the inconsistency. This validates the value of the adversarial validation phase in multi-agent review.
