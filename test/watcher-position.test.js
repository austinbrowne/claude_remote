const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * Simulates the file watcher's position-tracking logic.
 * This is the exact algorithm from processLogChanges() in server.js.
 */
function simulateWatcherRead(fileBuffer, lastPosition, maxReadSize = 64 * 1024) {
  const bytesToRead = Math.min(fileBuffer.length - lastPosition, maxReadSize);
  const chunk = fileBuffer.subarray(lastPosition, lastPosition + bytesToRead);
  const newContent = chunk.toString('utf8');
  const lastNewlineIndex = newContent.lastIndexOf('\n');
  if (lastNewlineIndex === -1) return { lines: [], newPosition: lastPosition };

  const completeContent = newContent.substring(0, lastNewlineIndex);
  const consumedBytes = Buffer.byteLength(completeContent + '\n', 'utf8');
  const lines = completeContent.split('\n').filter(line => line.trim());

  return { lines, newPosition: lastPosition + consumedBytes };
}

/**
 * The OLD (buggy) algorithm that used character-based position tracking.
 */
function simulateWatcherReadBuggy(fileBuffer, lastPosition, maxReadSize = 64 * 1024) {
  const bytesToRead = Math.min(fileBuffer.length - lastPosition, maxReadSize);
  const chunk = fileBuffer.subarray(lastPosition, lastPosition + bytesToRead);
  const newContent = chunk.toString('utf8');
  const lastNewlineIndex = newContent.lastIndexOf('\n');
  if (lastNewlineIndex === -1) return { lines: [], newPosition: lastPosition };

  const completeContent = newContent.substring(0, lastNewlineIndex);
  const lines = completeContent.split('\n').filter(line => line.trim());

  // BUG: uses character index instead of byte length
  return { lines, newPosition: lastPosition + lastNewlineIndex + 1 };
}

describe('Watcher position tracking', () => {
  it('ASCII-only content: both algorithms produce same result', () => {
    const jsonl = [
      JSON.stringify({ type: 'assistant', text: 'Hello world' }),
      JSON.stringify({ type: 'user', text: 'Hi there' }),
    ].join('\n') + '\n';
    const buf = Buffer.from(jsonl, 'utf8');

    const fixed = simulateWatcherRead(buf, 0);
    const buggy = simulateWatcherReadBuggy(buf, 0);

    assert.equal(fixed.lines.length, 2);
    assert.equal(buggy.lines.length, 2);
    assert.equal(fixed.newPosition, buggy.newPosition, 'ASCII: positions should match');
    assert.equal(fixed.newPosition, buf.length, 'Should consume entire buffer');
  });

  it('Multi-byte UTF-8: fixed algorithm tracks bytes correctly', () => {
    const jsonl = [
      JSON.stringify({ type: 'assistant', text: 'Hello 🌍 world' }),
      JSON.stringify({ type: 'user', text: 'Response here' }),
    ].join('\n') + '\n';
    const buf = Buffer.from(jsonl, 'utf8');

    const fixed = simulateWatcherRead(buf, 0);

    assert.equal(fixed.lines.length, 2);
    assert.equal(fixed.newPosition, buf.length, 'Should consume entire buffer');

    // Verify each line is valid JSON
    for (const line of fixed.lines) {
      assert.doesNotThrow(() => JSON.parse(line), `Line should be valid JSON: ${line.substring(0, 50)}`);
    }
  });

  it('Multi-byte UTF-8: buggy algorithm drifts behind', () => {
    const jsonl = [
      JSON.stringify({ type: 'assistant', text: 'Hello 🌍 world' }),
      JSON.stringify({ type: 'user', text: 'Response here' }),
    ].join('\n') + '\n';
    const buf = Buffer.from(jsonl, 'utf8');

    const buggy = simulateWatcherReadBuggy(buf, 0);

    assert.equal(buggy.lines.length, 2);
    // The buggy version should be BEHIND the actual byte length
    assert.ok(buggy.newPosition < buf.length,
      `Buggy position (${buggy.newPosition}) should be less than buffer length (${buf.length})`);
  });

  it('Incremental reads stay aligned with multi-byte content', () => {
    // Simulate a growing JSONL file with multi-byte characters
    const entries = [
      JSON.stringify({ type: 'thinking', text: 'Analyzing cödé with ünïcödé' }),
      JSON.stringify({ type: 'assistant', text: 'Here is the résult: café ☕' }),
      JSON.stringify({ type: 'user', text: 'Thanks! 👍' }),
      JSON.stringify({ type: 'assistant', text: 'More émojis: 🎉🚀✨' }),
    ];

    // Write entries incrementally and read after each
    let fullContent = '';
    let position = 0;
    const allParsed = [];

    for (const entry of entries) {
      fullContent += entry + '\n';
      const buf = Buffer.from(fullContent, 'utf8');

      const result = simulateWatcherRead(buf, position);
      allParsed.push(...result.lines);
      position = result.newPosition;
    }

    assert.equal(allParsed.length, 4, 'Should have parsed all 4 entries');
    assert.equal(position, Buffer.byteLength(fullContent, 'utf8'), 'Final position should match total bytes');

    // Every parsed line should be valid JSON
    for (const line of allParsed) {
      assert.doesNotThrow(() => JSON.parse(line));
    }
  });

  it('Buggy algorithm produces invalid JSON on second read with multi-byte content', () => {
    // This is the exact failure mode: after first read with multi-byte chars,
    // the buggy position is wrong, causing the next read to start mid-line
    const entry1 = JSON.stringify({ type: 'thinking', text: '🤔 deep thought with émojis 🎭🎪' });
    const entry2 = JSON.stringify({ type: 'assistant', text: 'Simple ASCII response' });
    const fullContent = entry1 + '\n' + entry2 + '\n';
    const buf = Buffer.from(fullContent, 'utf8');

    // First read with buggy algorithm
    const read1 = simulateWatcherReadBuggy(buf, 0);
    assert.equal(read1.lines.length, 2);

    // The buggy position is behind — second read starts mid-content
    if (read1.newPosition < buf.length) {
      const read2 = simulateWatcherRead(buf, read1.newPosition);
      // Whatever it reads will be garbage (partial line)
      for (const line of read2.lines) {
        // These lines will likely be invalid JSON fragments
        let isValid = true;
        try { JSON.parse(line); } catch { isValid = false; }
        // If there are lines, they should be invalid (proving the bug)
        if (read2.lines.length > 0) {
          assert.ok(!isValid || read2.lines.length === 0,
            'Buggy position should produce invalid JSON on subsequent reads');
        }
      }
    }

    // Now verify fixed algorithm doesn't have this problem
    const fixedRead1 = simulateWatcherRead(buf, 0);
    assert.equal(fixedRead1.newPosition, buf.length, 'Fixed algorithm consumes all bytes');
  });

  it('Handles multi-byte content with read size larger than entries', () => {
    // Use a read size that fits multiple entries to test chunked reading
    const entry1 = JSON.stringify({ type: 'assistant', text: '🌍 café résumé' });
    const entry2 = JSON.stringify({ type: 'assistant', text: '✨ more émojis 🎭' });
    const entry3 = JSON.stringify({ type: 'user', text: 'OK 👍' });
    const fullContent = entry1 + '\n' + entry2 + '\n' + entry3 + '\n';
    const buf = Buffer.from(fullContent, 'utf8');

    // Read size that fits entry1+entry2 but not all three
    const entry1Bytes = Buffer.byteLength(entry1 + '\n', 'utf8');
    const entry2Bytes = Buffer.byteLength(entry2 + '\n', 'utf8');
    const readSize = entry1Bytes + entry2Bytes + 5; // Fits first two + partial third

    let position = 0;
    const allParsed = [];
    let iterations = 0;

    while (position < buf.length && iterations < 10) {
      const result = simulateWatcherRead(buf, position, readSize);
      if (result.newPosition === position) break;
      allParsed.push(...result.lines);
      position = result.newPosition;
      iterations++;
    }

    assert.equal(allParsed.length, 3, 'Should parse all 3 entries across reads');
    assert.equal(position, buf.length, 'Should reach end of buffer');
    for (const line of allParsed) {
      assert.doesNotThrow(() => JSON.parse(line));
    }
  });

  it('Real-world JSONL: position tracks correctly with actual session data', async () => {
    // Test with a real JSONL file if available
    const testFile = path.join(os.tmpdir(), 'watcher-test.jsonl');
    const entries = [
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Let me analyze the café résumé' }] } },
      { type: 'user', message: { content: 'Sounds good 👍' } },
      { type: 'assistant', message: { content: [{ type: 'thinking', text: 'Hmm, the naïve approach won\'t work…' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Here\'s the plan: step①, step②, step③' }] } },
      { type: 'user', message: { content: 'Perfect ✅' } },
    ];

    const jsonl = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.writeFileSync(testFile, jsonl, 'utf8');

    try {
      const buf = fs.readFileSync(testFile);
      let position = 0;
      const allParsed = [];

      while (position < buf.length) {
        const result = simulateWatcherRead(buf, position);
        if (result.newPosition === position) break;
        allParsed.push(...result.lines);
        position = result.newPosition;
      }

      assert.equal(allParsed.length, 5);
      assert.equal(position, buf.length);

      // Verify round-trip: parsed JSON matches original
      for (let i = 0; i < allParsed.length; i++) {
        const parsed = JSON.parse(allParsed[i]);
        assert.deepEqual(parsed, entries[i]);
      }
    } finally {
      fs.unlinkSync(testFile);
    }
  });
});
