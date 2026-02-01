---
title: "Multi-Agent Review Checklist"
date: "2026-01-30"
category: "checklist"
tags: ["code-review", "multi-agent", "swift"]
---

# Multi-Agent Code Review Checklist

Use this checklist before, during, and after parallel agent reviews.

## Pre-Review Setup

### Context & Documentation
- [ ] Roadmap and phase breakdown document shared with agents
- [ ] Architectural Decision Record (ADR) provided for design choices
- [ ] Security threat model documented with rationale for each decision
- [ ] "Out of scope" boundaries clearly defined
- [ ] Known false-positive patterns listed for this domain

### Language Constraints
- [ ] Agents briefed on Swift 6 concurrency requirements
- [ ] Sendable protocol constraints explained
- [ ] Actor isolation rules documented
- [ ] Common agent mistakes from previous reviews shared

### File Organization
- [ ] File ownership matrix created (who owns which files)
- [ ] Dependency graph mapped (which files interact)
- [ ] Conflict risk matrix generated (which files might overlap)
- [ ] Parallel task groups verified to have minimal overlap

### Test Suite
- [ ] Full test suite runs cleanly before review starts (baseline)
- [ ] Tests with direct property access flagged
- [ ] Visibility-dependent tests documented
- [ ] Test coverage metrics recorded

## During Review Execution

### Agent Instructions
- [ ] Agents given explicit file assignments (non-overlapping)
- [ ] "Reference the roadmap" instruction included in prompts
- [ ] "Document security decisions" required for non-obvious choices
- [ ] "Flag YAGNI concerns with phase references" requested
- [ ] "Check for Swift 6 violations" explicit requirement

### Monitoring
- [ ] Track which files each agent is modifying
- [ ] Watch for overlapping edits in real-time
- [ ] Monitor for Sendable/concurrency pattern violations
- [ ] Flag any "double unwrap" patterns as they appear

## Post-Review Integration

### Compilation Gate
- [ ] All changes merged or staged
- [ ] Run Xcode build: `xcodebuild -scheme ClaudeRemote clean build`
- [ ] Zero compile errors (mandatory)
- [ ] Zero compiler warnings related to concurrency/Sendable
- [ ] Build artifacts verified

### Test Validation
- [ ] Full test suite executed: `xcodebuild -scheme ClaudeRemote test`
- [ ] All tests pass (no failures, no skipped tests)
- [ ] Coverage metrics maintained or improved
- [ ] Any visibility-dependent tests still green

### Code Quality Checks

**Sendable Violations**
```bash
# Search for problematic patterns
grep -r "static let" Sources/ | grep -i "formatter\|shared\|global"
grep -r "ISO8601DateFormatter" Sources/
```

**Optional Unwrapping**
```bash
# Find potential double-unwrap issues
grep -n "guard let self\|if let self" Sources/ | sort | uniq
# Manually verify context
```

**Visibility Changes**
```bash
# Grep test files for direct property access to recently made-private properties
grep -r "\.token\|\.session\|\.connection" Tests/
```

**Parallel Conflicts**
```bash
# Check git status for merge conflicts
git status | grep "both modified"
```

### Review Findings Validation

For each "YAGNI" or "unnecessary code" finding:
- [ ] Cross-reference against roadmap (phases 1-7)
- [ ] Confirm it's NOT earmarked for a future phase
- [ ] Verify no comments explain the future purpose
- [ ] Only remove if truly unnecessary

For each security finding:
- [ ] Check ADR or architecture document for design rationale
- [ ] Verify it's not an intentional design choice
- [ ] Confirm risk was explicitly accepted in requirements
- [ ] Only fix if it contradicts documented decisions

For each concurrency-related finding:
- [ ] Verify against Swift 6 compiler output
- [ ] Test on actual Xcode build
- [ ] Confirm not a false positive from agent analysis

## Merge Gate

**DO NOT MERGE** until all items below are confirmed:

- [ ] Xcode build: **PASSES** (zero errors)
- [ ] Test suite: **ALL PASS** (zero failures)
- [ ] Compiler warnings: **ZERO** (especially Sendable)
- [ ] YAGNI findings: **ROADMAP-REVIEWED** (not earmarked)
- [ ] Security findings: **RATIONALE-CHECKED** (intentional or fixed)
- [ ] Visibility changes: **TEST-VERIFIED** (tests still pass)
- [ ] Double unwraps: **ELIMINATED** (grep verified)
- [ ] File conflicts: **RESOLVED** (no merge conflicts)

## Quick Reference: Common Issues

| Issue | Detection | Fix |
|-------|-----------|-----|
| Sendable violation | Compiler error on `static let` globals | Wrap in Sendable type or use lazy initialization |
| Double unwrap | `guard let self` twice in closure | Remove second guard, use first unwrapped value |
| Broken test | Test fails with "Cannot access private member" | Update test or revert visibility change |
| YAGNI false positive | Code flagged as unused | Reference roadmap phase where it's needed |
| Merge conflict | Git shows "both modified" | Review both agent's changes, test integrated result |
| Compile error after merge | `xcodebuild` fails | Run compiler output through diff, find conflicting edits |

---

**Template for Review Briefing**

Include this in your agent review prompt:

```
MULTI-AGENT REVIEW CONTEXT:

Roadmap: [Link to phase plan]
Architecture: [Link to ADR]
Files You Own: [List of files this agent can modify]
AVOID: [List of files other agents are modifying]
Out of Scope: [What NOT to change]

SWIFT 6 GOTCHAS:
- No mutable static globals (not Sendable)
- Check optional state after unwrapping
- Actor isolation on concurrent code
- Formatter instances must be thread-safe

COMMON FALSE POSITIVES:
- Code flagged YAGNI may be for Phase 2-7 (check roadmap)
- ws:// is intentional for local network (not a security issue)

BEFORE SUBMITTING:
1. Check your changes don't conflict with [other agents]
2. Cross-reference any YAGNI flags against the roadmap
3. Note any security decisions with rationale in comments
```
