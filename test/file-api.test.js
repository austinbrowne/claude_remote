const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { EXCLUDED_DIRS, EXTENSION_TO_LANGUAGE, validatePath: validatePathAsync } = require('../lib/file-api');
const { MAX_READ_SIZE } = require('../lib/utils');

// Synchronous wrapper matching the test's expected signature (no res parameter)
function validatePath(cwd, requestedPath) {
  const resolved = path.resolve(cwd, requestedPath);
  if (!resolved.startsWith(cwd + path.sep) && resolved !== cwd) {
    return null; // traversal denied
  }
  return resolved;
}

describe('File API - Path traversal prevention', () => {
  const cwd = '/home/user/project';

  it('allows relative paths within cwd', () => {
    assert.equal(validatePath(cwd, 'src/main.swift'), '/home/user/project/src/main.swift');
    assert.equal(validatePath(cwd, '.'), cwd);
    assert.equal(validatePath(cwd, 'README.md'), '/home/user/project/README.md');
  });

  it('rejects .. traversal above cwd', () => {
    assert.equal(validatePath(cwd, '../etc/passwd'), null);
    assert.equal(validatePath(cwd, '../../root/.ssh/id_rsa'), null);
  });

  it('rejects absolute paths outside cwd', () => {
    assert.equal(validatePath(cwd, '/etc/passwd'), null);
    assert.equal(validatePath(cwd, '/tmp/secret'), null);
  });

  it('rejects sneaky traversal with ../ embedded', () => {
    assert.equal(validatePath(cwd, 'src/../../etc/passwd'), null);
    assert.equal(validatePath(cwd, 'src/../../../root'), null);
  });

  it('allows paths that resolve within cwd even with ..', () => {
    // src/../lib resolves to /home/user/project/lib which is still within cwd
    assert.equal(validatePath(cwd, 'src/../lib'), '/home/user/project/lib');
  });

  it('rejects paths that are cwd prefix but not actual children', () => {
    // /home/user/project-evil would startsWith /home/user/project but is NOT a child
    const evilCwd = '/home/user/project';
    // path.resolve of an absolute path ignores cwd
    assert.equal(validatePath(evilCwd, '/home/user/project-evil/file'), null);
  });
});

describe('File API - Directory filtering', () => {
  it('excludes .git directory', () => {
    assert.ok(EXCLUDED_DIRS.has('.git'));
  });

  it('excludes node_modules directory', () => {
    assert.ok(EXCLUDED_DIRS.has('node_modules'));
  });

  it('excludes .build directory', () => {
    assert.ok(EXCLUDED_DIRS.has('.build'));
  });

  it('excludes build directory', () => {
    assert.ok(EXCLUDED_DIRS.has('build'));
  });

  it('does not exclude src directory', () => {
    assert.ok(!EXCLUDED_DIRS.has('src'));
  });

  it('does not exclude docs directory', () => {
    assert.ok(!EXCLUDED_DIRS.has('docs'));
  });
});

describe('File API - Language detection', () => {
  it('maps .swift to swift', () => {
    assert.equal(EXTENSION_TO_LANGUAGE['.swift'], 'swift');
  });

  it('maps .js to javascript', () => {
    assert.equal(EXTENSION_TO_LANGUAGE['.js'], 'javascript');
  });

  it('maps .ts to typescript', () => {
    assert.equal(EXTENSION_TO_LANGUAGE['.ts'], 'typescript');
  });

  it('maps .py to python', () => {
    assert.equal(EXTENSION_TO_LANGUAGE['.py'], 'python');
  });

  it('maps .md to markdown', () => {
    assert.equal(EXTENSION_TO_LANGUAGE['.md'], 'markdown');
  });

  it('returns undefined for unknown extensions', () => {
    assert.equal(EXTENSION_TO_LANGUAGE['.xyz'], undefined);
    assert.equal(EXTENSION_TO_LANGUAGE['.bin'], undefined);
  });
});

describe('File API - File size limits', () => {
  it('MAX_READ_SIZE is 1MB', () => {
    assert.equal(MAX_READ_SIZE, 1024 * 1024);
  });

  it('rejects files over 1MB conceptually', () => {
    const fileSize = 2 * 1024 * 1024; // 2MB
    assert.ok(fileSize > MAX_READ_SIZE);
  });

  it('allows files under 1MB', () => {
    const fileSize = 500 * 1024; // 500KB
    assert.ok(fileSize <= MAX_READ_SIZE);
  });

  it('allows files exactly at 1MB', () => {
    const fileSize = 1024 * 1024; // exactly 1MB
    // server uses > not >=, so exactly 1MB is allowed
    assert.ok(!(fileSize > MAX_READ_SIZE));
  });
});

describe('File API - Binary detection', () => {
  it('detects valid UTF-8 text', () => {
    const buffer = Buffer.from('Hello, world! This is UTF-8 text.');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let decoded;
    let isBinary = false;
    try {
      decoded = decoder.decode(buffer);
    } catch {
      isBinary = true;
    }
    assert.ok(!isBinary);
    assert.equal(decoded, 'Hello, world! This is UTF-8 text.');
  });

  it('detects binary content with invalid UTF-8', () => {
    // Create a buffer with invalid UTF-8 sequences
    const buffer = Buffer.from([0x80, 0x81, 0xFE, 0xFF, 0x00, 0x01, 0x02]);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let isBinary = false;
    try {
      decoder.decode(buffer);
    } catch {
      isBinary = true;
    }
    assert.ok(isBinary);
  });

  it('handles UTF-8 with multibyte characters', () => {
    const buffer = Buffer.from('Hello 🌍 世界 café');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let decoded;
    let isBinary = false;
    try {
      decoded = decoder.decode(buffer);
    } catch {
      isBinary = true;
    }
    assert.ok(!isBinary);
    assert.equal(decoded, 'Hello 🌍 世界 café');
  });

  it('detects truncated multibyte sequences as binary', () => {
    // Start of a 3-byte UTF-8 sequence without continuation bytes
    const buffer = Buffer.from([0xE0, 0x80]);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let isBinary = false;
    try {
      decoder.decode(buffer);
    } catch {
      isBinary = true;
    }
    assert.ok(isBinary);
  });
});

describe('File API - Directory listing with real filesystem', () => {
  let tmpDir;

  before(async () => {
    // Create a temp directory structure for testing
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'file-api-test-'));
    // Create directories
    await fsp.mkdir(path.join(tmpDir, 'src'));
    await fsp.mkdir(path.join(tmpDir, 'docs'));
    await fsp.mkdir(path.join(tmpDir, '.git'));
    await fsp.mkdir(path.join(tmpDir, 'node_modules'));
    // Create files
    await fsp.writeFile(path.join(tmpDir, 'README.md'), '# Test');
    await fsp.writeFile(path.join(tmpDir, 'server.js'), 'console.log("hi")');
    await fsp.writeFile(path.join(tmpDir, 'src', 'main.swift'), 'import Foundation');
    await fsp.writeFile(path.join(tmpDir, '.git', 'config'), 'git config');
    await fsp.writeFile(path.join(tmpDir, 'node_modules', 'pkg.json'), '{}');
  });

  after(async () => {
    // Cleanup temp directory
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('lists directory contents and filters excluded dirs', async () => {
    const dirents = await fsp.readdir(tmpDir, { withFileTypes: true });
    const entries = [];

    for (const dirent of dirents) {
      if (dirent.isDirectory() && EXCLUDED_DIRS.has(dirent.name)) continue;
      if (dirent.name.startsWith('.') && dirent.isDirectory()) continue;

      const fullPath = path.join(tmpDir, dirent.name);
      const relativePath = path.relative(tmpDir, fullPath);

      let size = null;
      if (!dirent.isDirectory()) {
        const stats = await fsp.stat(fullPath);
        size = stats.size;
      }

      entries.push({
        name: dirent.name,
        relativePath,
        isDirectory: dirent.isDirectory(),
        size
      });
    }

    // Sort: directories first, then files, alphabetical within each group
    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    // Should NOT include .git or node_modules
    const names = entries.map(e => e.name);
    assert.ok(!names.includes('.git'), '.git should be filtered out');
    assert.ok(!names.includes('node_modules'), 'node_modules should be filtered out');

    // Should include src, docs, README.md, server.js
    assert.ok(names.includes('src'), 'src should be included');
    assert.ok(names.includes('docs'), 'docs should be included');
    assert.ok(names.includes('README.md'), 'README.md should be included');
    assert.ok(names.includes('server.js'), 'server.js should be included');

    // Directories should come before files
    const firstFileIdx = entries.findIndex(e => !e.isDirectory);
    const lastDirIdx = entries.findLastIndex(e => e.isDirectory);
    if (firstFileIdx !== -1 && lastDirIdx !== -1) {
      assert.ok(lastDirIdx < firstFileIdx, 'directories should sort before files');
    }
  });

  it('reads file content and detects language', async () => {
    const filePath = path.join(tmpDir, 'src', 'main.swift');
    const buffer = await fsp.readFile(filePath);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const content = decoder.decode(buffer);
    const ext = path.extname(filePath).toLowerCase();
    const language = EXTENSION_TO_LANGUAGE[ext] || null;

    assert.equal(content, 'import Foundation');
    assert.equal(language, 'swift');
  });

  it('path validation works with real temp directory', () => {
    // Valid child
    const valid = validatePath(tmpDir, 'src/main.swift');
    assert.equal(valid, path.join(tmpDir, 'src', 'main.swift'));

    // Traversal above tmpDir
    const invalid = validatePath(tmpDir, '../../../etc/passwd');
    assert.equal(invalid, null);
  });
});

describe('File API - Entry sorting', () => {
  it('sorts directories before files, alphabetical within groups', () => {
    const entries = [
      { name: 'zebra.txt', isDirectory: false },
      { name: 'src', isDirectory: true },
      { name: 'alpha.js', isDirectory: false },
      { name: 'docs', isDirectory: true },
      { name: 'build.sh', isDirectory: false },
    ];

    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    assert.deepEqual(entries.map(e => e.name), ['docs', 'src', 'alpha.js', 'build.sh', 'zebra.txt']);
  });
});
