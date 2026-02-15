---
type: standard
name: document-viewer
status: in_progress
date: 2026-02-15
tags: [ios, ui, feature, file-viewer, markdown]
security_sensitive: false
---

# Document Viewer Plan

## Problem

During Claude Code sessions, users have no visibility into project artifacts (source files, READMEs, plans, configs) from the iOS app. The only way to see file content is to watch tool call results scroll by in the chat. There's no way to browse or read project files on demand.

## Goals

1. Let users browse the file tree of the git repo associated with the current session
2. Render markdown files with rich formatting (reusing existing MarkdownUI infrastructure)
3. Render code files with syntax highlighting (reusing existing Highlightr infrastructure)
4. Keep it simple — read-only viewer, not an editor

## Solution

A sheet-based document viewer accessible from the toolbar. The server provides two new **REST endpoints** for directory listings and file content. The iOS client renders a hierarchical file tree with tap-to-view file content.

REST is the right choice here — file requests are stateless request/response pairs, not real-time streams. The existing WebSocket protocol stays focused on live session output.

## Technical Approach

### Data Flow

```
User taps doc icon in toolbar
  → Sheet opens with FileTreeView
  → Client sends GET /api/files?sessionId=X&path=.
  → Server reads directory from session's cwd
  → Server responds with JSON array of entries
  → User taps a file
  → Client sends GET /api/file?sessionId=X&path=src/main.swift
  → Server reads file, detects language
  → Server responds with JSON { content, language, size }
  → Client renders markdown or syntax-highlighted code
```

### Server Changes (server.js)

**New REST endpoints** (added alongside existing `/health` routes):

1. `GET /api/files` — List directory contents
   - Query params: `sessionId`, `path` (relative to cwd, defaults to `.`)
   - Server reads directory using `fs.readdir` with `withFileTypes: true`
   - Filters: skip `.git/`, `node_modules/`, `.build/`, `build/`
   - Returns: `{ path, entries: [{ name, relativePath, isDirectory, size }] }`
   - Entries sorted: directories first, then files, alphabetical within each group
   - Security: validate path doesn't escape cwd (no `..` traversal)
   - Auth: requires Bearer token (same as `/health/detailed`)

2. `GET /api/file` — Read file content
   - Query params: `sessionId`, `path` (relative to cwd)
   - Server reads file using `fs.readFile` with size limit (1MB)
   - Detects language from file extension (`.swift` → `swift`, `.js` → `javascript`, etc.)
   - Returns: `{ path, content, language, size }`
   - If file can't be decoded as UTF-8, returns `{ path, error: "Binary file", size }`
   - Security: validate path within cwd
   - Auth: requires Bearer token

**Security:**
- Path traversal prevention: `path.resolve(cwd, requestedPath)` must start with `cwd`
- File size limit: reject files > 1MB with `{ error: "File too large", size }`
- Binary detection: attempt UTF-8 decode, return error if invalid
- Auth: reuses existing `secureCompare` Bearer token auth

### iOS Changes

**New files:**

1. `DocumentViewerSheet.swift` — Main sheet view with NavigationStack
   - Toolbar button in ContentView.swift
   - NavigationStack for directory traversal + file content
   - Uses `@Environment(AppCoordinator.self)` to access the server URL and auth token for REST calls

2. `FileTreeView.swift` — Directory listing view
   - List of FileEntry items, folders at top, files below
   - Folders show chevron, tap pushes subdirectory via NavigationLink
   - Files show icon based on extension, tap pushes FileContentView
   - Loading state with ProgressView
   - Error state if request fails

3. `FileContentView.swift` — File content display
   - Markdown files (`.md`): render with `Markdown()` view using existing theme from MessageView
   - Code files: render with `CodeBlockView` (existing component)
   - Plain text: render in monospaced font
   - Copy-all button in toolbar
   - File name + size in navigation title

4. `FileEntry.swift` — Model for file/directory entries
   ```swift
   struct FileEntry: Identifiable, Codable, Hashable {
       let name: String
       let relativePath: String
       let isDirectory: Bool
       let size: Int?
       var id: String { relativePath }
   }
   ```
   Uses `relativePath` as ID — unique across the entire tree, prevents collisions between files with the same name in different directories.

5. `DocumentService.swift` — REST client for file requests
   - `fetchFiles(sessionId:path:) async throws -> [FileEntry]`
   - `fetchFileContent(sessionId:path:) async throws -> FileContent`
   - Uses `URLSession` with the server's base URL and Bearer token
   - Simple async/await — no WebSocket correlation needed

**No changes to WebSocketMessage.swift** — file requests use REST, not WebSocket.

**Reused existing components:**
- MarkdownUI + custom theme (from MessageView.swift)
- SharedSyntaxHighlighter (from MessageView.swift)
- CodeBlockView (existing component with copy button, syntax highlighting)
- SyntaxHighlighting.highlight() singleton (no new instances)

### UI Design

File tree (root view):
```
┌──────────────────────────────┐
│  ← Documents                 │
├──────────────────────────────┤
│ 📁 ClaudeRemote/          >  │
│ 📁 docs/                  >  │
│ 📁 public/                >  │
│ 📁 test/                  >  │
│ 📄 CLAUDE.md           2 KB  │
│ 📄 package.json        1 KB  │
│ 📄 server.js          89 KB  │
│ 📄 README.md           3 KB  │
└──────────────────────────────┘
```

File content (pushed detail):
```
┌──────────────────────────────┐
│  ← Back     CLAUDE.md  📋   │
│  2.1 KB                      │
├──────────────────────────────┤
│                              │
│  # Claude Remote             │
│                              │
│  Mobile companion app for    │
│  monitoring and controlling  │
│  Claude Code sessions...     │
│                              │
│  ## Development              │
│  ...rendered markdown...     │
│                              │
└──────────────────────────────┘
```

Empty directory:
```
┌──────────────────────────────┐
│  ← Documents                 │
├──────────────────────────────┤
│                              │
│     📁                       │
│     Empty directory          │
│                              │
└──────────────────────────────┘
```

Error state:
```
┌──────────────────────────────┐
│  ← Documents                 │
├──────────────────────────────┤
│                              │
│     ⚠️                       │
│     Could not load files     │
│     [Retry]                  │
│                              │
└──────────────────────────────┘
```

No session selected (toolbar button hidden):
- Document viewer button only appears when `state.currentSessionId != nil`

## Implementation Steps

1. **Server: Add REST endpoints** (server.js)
   - Add `GET /api/files` and `GET /api/file` with auth middleware
   - Path traversal prevention
   - Directory filtering (.git, node_modules, .build)
   - UTF-8 decode check for binary detection
   - File size limits

2. **iOS: Add FileEntry model** (FileEntry.swift)
   - Struct with name, relativePath, isDirectory, size
   - `id` is `relativePath` for uniqueness

3. **iOS: Add DocumentService** (DocumentService.swift)
   - REST client with async/await
   - Uses server URL and auth token from AppCoordinator

4. **iOS: Build FileTreeView** (FileTreeView.swift)
   - Directory listing with folder/file icons
   - NavigationLink for both folders and files
   - Loading, empty, and error states

5. **iOS: Build FileContentView** (FileContentView.swift)
   - Markdown rendering for .md files
   - Code rendering for source files via CodeBlockView
   - Plain text fallback
   - Loading and error states

6. **iOS: Build DocumentViewerSheet** (DocumentViewerSheet.swift)
   - Sheet container with NavigationStack
   - Root FileTreeView at path "."

7. **iOS: Add toolbar button in ContentView**
   - Doc icon next to existing toolbar items
   - Only shown when a session is selected

8. **Tests**
   - Node: test path traversal rejection, directory filtering, file size limits, binary detection
   - Swift: test FileEntry decoding, DocumentService URL construction

## Affected Files

| File | Change |
|------|--------|
| `server.js` | Add `/api/files` and `/api/file` REST endpoints |
| `ContentView.swift` | Add toolbar button for document viewer |
| **New:** `DocumentViewerSheet.swift` | Main sheet view |
| **New:** `FileTreeView.swift` | Directory listing |
| **New:** `FileContentView.swift` | File content display |
| **New:** `FileEntry.swift` | File entry model |
| **New:** `DocumentService.swift` | REST client for file requests |

## Acceptance Criteria

- [ ] User can open document viewer from toolbar (only when session is selected)
- [ ] File tree shows directories and files from session's cwd
- [ ] Directories are navigable (tap to enter, back button to go up)
- [ ] Markdown files render with formatted headings, lists, code blocks
- [ ] Code files render with syntax highlighting
- [ ] Files > 1MB show "File too large" error
- [ ] Path traversal attacks are rejected (server returns 403)
- [ ] Binary files show "Binary file" message
- [ ] .git/, node_modules/, .build/ are excluded from listings
- [ ] Loading states shown while fetching
- [ ] Empty directory shows "Empty directory" message
- [ ] Network errors show error state with retry button
- [ ] Toolbar button hidden when no session selected

## Test Strategy

- **Server unit tests:** Path traversal rejection, directory filtering, file size limits, binary detection, auth requirement
- **Swift unit tests:** FileEntry decoding, DocumentService URL construction
- **Manual testing:** Browse real repo, open markdown files, open code files, navigate directories, test on device

## Security Review

- Path traversal: resolved paths validated against cwd prefix; server returns 403 on violation
- File size limits: 1MB max prevents memory exhaustion
- Binary detection: UTF-8 decode attempt, error on failure (no null-byte heuristic needed)
- Auth: REST endpoints require Bearer token via existing `secureCompare`
- No user input rendered as HTML (SwiftUI text rendering is safe)

## Risks

| Risk | Mitigation |
|------|------------|
| Large repos with many files | Filter .git/node_modules/.build; consider depth limit |
| Binary files crashing the app | UTF-8 decode check on server, error response |
| Path traversal attacks | Resolve paths, verify within cwd, 403 on violation |
| Session cwd is null | Hide toolbar button when no session; DocumentService returns error |

## Past Learnings Applied

- Reuse `SyntaxHighlighting.highlight()` singleton — don't create new Highlightr instances
- Sheet must read from `@Environment`, not captured init params
- Don't use `UUID()` in computed properties for ForEach identity — use `relativePath`
- Heavy file parsing off main thread via `Task.detached` with `nonisolated static`
- Use existing truncation pattern from `ToolCardHelpers.truncateResult()` for large files
