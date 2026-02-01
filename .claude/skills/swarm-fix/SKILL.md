# Swarm Fix

Fix all code review findings in parallel using non-conflicting file-segmented subagents.

## When to Use

After a multi-agent code review produces a list of findings that need fixing. This skill groups fixes by file ownership to avoid edit conflicts, then launches parallel agents to apply all fixes simultaneously.

## Workflow

### Phase 1: Triage Findings

1. Collect all review findings from the review output
2. Categorize by priority:
   - **P1 (Critical)**: Bugs, race conditions, data loss risks — fix immediately
   - **P2 (Important)**: API design issues, retain cycles, type safety — fix before merge
   - **P3 (Nice-to-have)**: Style, naming, minor duplication — fix if low effort
3. Present the triaged list to the user for approval. User may skip P3s.

### Phase 2: Group by File Ownership

1. Map each finding to the file(s) it touches
2. Group findings into non-conflicting segments where no two agents edit the same file
3. Identify cross-agent API contracts (e.g., if Agent A changes a function signature, Agent B needs to update callers)
4. Document the exact API contracts between groups so agents can work independently

**Example grouping:**
```
Agent A: ModelFile.swift — findings #1, #5
Agent B: ServiceFile.swift — findings #2, #3, #7
Agent C: ViewFileA.swift + ViewFileB.swift — findings #4, #6
Agent D: TestFile.swift — findings #8 (depends on API contracts from A, B)
```

### Phase 3: Launch Parallel Agents

For each group, launch a Task agent with:
- The exact file path(s) to edit
- The current file contents (or instructions to read first)
- Detailed edit instructions for each finding (old string → new string)
- Any API contracts from other groups that affect this group's edits

**Key principles:**
- Each agent owns its files exclusively — no overlapping edits
- Give agents exact edit instructions, not vague descriptions
- Include the "why" for each fix so agents can verify correctness
- For test files, include the new API signatures so tests compile

Launch all agents in a single message using multiple Task tool calls.

### Phase 4: Build & Test

After all agents complete:
1. Run the project build command (e.g., `swift build`, `npm run build`)
2. If build fails, identify which agent's edits caused the issue
3. Fix build errors (usually minor API mismatches between agents)
4. Run the full test suite
5. If tests fail, fix and re-run

### Phase 5: Verify

1. Run `git diff` to review all changes holistically
2. Ensure no unintended changes leaked in
3. Confirm all findings from the triage list are addressed

## Tips

- **Keep agents small**: 2-4 findings per agent is ideal. More than 6 risks confusion.
- **Tests last**: Always put test updates in their own agent since they depend on all API changes.
- **haiku for trivial fixes**: Use `model: haiku` for agents that only update comments or make < 3-line changes.
- **Document contracts**: The #1 cause of build failures is API mismatches between agents. Write exact signatures.
- **Read before edit**: Always instruct agents to read files before editing.

## Example Invocation

```
User: "Fix all review findings"

1. Triage: 2 P1, 5 P2, 5 P3 findings
2. Group: 5 agents by file ownership
3. Launch: 5 parallel Task agents + 1 test agent
4. Build: swift build → fix any mismatches → swift test
5. Verify: git diff → confirm all 12 findings addressed
```
