---
title: "Multi-Agent Code Review Prevention Strategies"
date: "2026-01-30"
category: "best-practices"
tags: ["code-review", "multi-agent", "swift", "concurrent-development"]
context: "27 findings from 5-agent parallel review of iOS native app; addressed false positives, integration bugs, and concurrency issues"
---

## Prevention Strategies

1. **Pre-review Roadmap Alignment**
   - Attach the complete product roadmap and phase timelines to review prompts
   - Explicitly mark "intentional future-proofing" comments in code earmarked for later phases
   - Provide review agents with the project context document that defines scope for THIS phase vs. FUTURE phases
   - Prevents YAGNI false positives on code that's already planned

2. **Threat Model Documentation**
   - Document architectural security decisions (e.g., "ws:// on local network only per design spec")
   - Link security decisions to requirements or risk assessments in review briefing
   - Use a "security rationale" section in code comments for non-obvious choices
   - Prevents reviewers from re-litigating intentional design decisions

3. **Language-Specific Constraint Enforcement**
   - Brief reviewers on Swift 6 concurrency rules (Sendable requirement, actor isolation)
   - Use a pre-flight compiler check before code review to catch compile-time errors
   - Include "known Swift 6 gotchas" in the review prompt
   - Prevents agents from introducing concurrency violations that won't surface until later

4. **File Ownership & Dependency Mapping**
   - Create a dependency graph showing which files touch which modules
   - Group parallel review tasks by non-overlapping file sets
   - Use a conflict matrix to identify files modified by multiple agents
   - Prevents merge conflicts and double-unwrap errors from parallel edits

5. **Test Suite Alignment**
   - Run full test suite before parallel review to establish baseline
   - Mark tests that depend on internal visibility (private vs. public)
   - Include test failures as a hard blocker in parallel execution
   - Prevents visibility changes from breaking test coverage

6. **Compilation as a Gate**
   - Require successful Xcode compilation as a mandatory check after all parallel fixes
   - Don't merge changes that don't compile, even if they pass linting
   - Use Swift compiler output as the source of truth for concurrency and type errors
   - Prevents subtle type violations from slipping through

7. **Double-Unwrap Detection**
   - Grep for consecutive `guard let self` or `if let` patterns in closures
   - Flag optional unwrapping in scopes where the variable can't be optional
   - Use a pre-commit hook to catch redundant unwrapping patterns
   - Prevents logic errors from duplicate guards on non-optional values

## Best Practices for Multi-Agent Reviews

### Planning Phase
- [ ] Provide agents with the complete roadmap and phase breakdown
- [ ] Include a "out of scope for this phase" section in review briefing
- [ ] Share the architectural decision record (ADR) for security choices
- [ ] Define which changes are "breaking" vs. "additive" for existing functionality

### Review Execution
- [ ] Brief reviewers on language-specific constraints (Swift 6, Sendable, etc.)
- [ ] Include known false-positive patterns from previous reviews
- [ ] Group agents by file ownership to minimize conflicts
- [ ] Provide agents with a conflict map showing which files overlap

### Integration Phase
- [ ] Run full test suite after ALL parallel fixes are applied
- [ ] Compile the project and fix any compiler errors before merge
- [ ] Check for common multi-agent issues: duplicate guards, visibility changes, Sendable violations
- [ ] Require green CI/CD status before considering review complete

### Validation
- [ ] Verify no compile-time errors (swift compiler is source of truth)
- [ ] Confirm all tests pass, especially those with visibility dependencies
- [ ] Spot-check for double-unwrap patterns and redundant guards
- [ ] Review agent comments for "YAGNI" flags and cross-reference against roadmap

## Swift 6 Concurrency Gotchas

### Sendable Constraints
- **Problem**: Global `ISO8601DateFormatter` instances fail Sendable check in Swift 6
- **Root Cause**: Formatters are mutable, violating actor isolation rules
- **Prevention**: Use static computed properties or lazy initialization with proper synchronization, or bundle formatters in a Sendable wrapper
- **Detection**: Swift compiler will catch this; can't be missed if you compile

### Optional Unwrapping in Closures
- **Problem**: `guard let self` used twice in a closure when `self` is non-optional after first unwrap
- **Root Cause**: Agents forget that unwrapping removes optionality in that scope
- **Prevention**: Enforce single-pass control flow in closure unwrapping; use if-let chains instead of consecutive guards
- **Detection**: Swift compiler error; manual code review of closure patterns

### Visibility Changes Breaking Tests
- **Problem**: Making properties private (`private let token`) breaks tests that directly access them
- **Root Cause**: Agents optimize visibility without checking test dependencies
- **Prevention**: Always grep for direct property access in test files before changing visibility
- **Detection**: Test suite failure; mandatory pre-merge requirement

### Parallel File Modifications
- **Problem**: Two agents modify the same file simultaneously, creating merge conflicts or subtle logic errors
- **Root Cause**: No conflict awareness in parallel execution planning
- **Prevention**: Create explicit file ownership matrix; group parallel tasks to avoid overlap
- **Detection**: Git merge conflicts; manual review of overlapping edits

## Implementation Checklist

When executing multi-agent reviews on Swift projects:

- [ ] Swift compiler validates all changes (mandatory gate)
- [ ] Full test suite passes with zero failures
- [ ] No compile errors related to Sendable or concurrency
- [ ] No redundant optional unwrapping patterns
- [ ] Visibility changes reviewed against test suite
- [ ] File ownership groups verified to have no overlap
- [ ] Security decisions documented with rationale
- [ ] Roadmap context provided to all review agents
- [ ] All YAGNI flags cross-referenced against phase plan
- [ ] No breaking changes to public APIs

---

**Next Review**: Apply this framework to [next multi-agent review cycle] and measure:
- Reduction in false-positive findings
- Decrease in compile-time errors after parallel execution
- Test pass rate on first merge attempt
- Time spent on integration debugging
