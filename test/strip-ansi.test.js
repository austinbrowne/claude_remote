const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { stripAnsi } = require('../lib/utils');

describe('stripAnsi', () => {
  it('passes through plain text unchanged', () => {
    assert.equal(stripAnsi('hello world'), 'hello world');
  });

  it('strips single color code', () => {
    assert.equal(stripAnsi('\x1b[31mred text\x1b[0m'), 'red text');
  });

  it('strips bold and underline codes', () => {
    assert.equal(stripAnsi('\x1b[1mbold\x1b[0m \x1b[4munderline\x1b[0m'), 'bold underline');
  });

  it('strips multi-parameter codes', () => {
    assert.equal(stripAnsi('\x1b[1;31;40mstyle\x1b[0m'), 'style');
  });

  it('strips cursor movement codes', () => {
    assert.equal(stripAnsi('\x1b[2Aup\x1b[3Bdown'), 'updown');
  });

  it('handles empty string', () => {
    assert.equal(stripAnsi(''), '');
  });

  it('handles string with no ANSI codes', () => {
    assert.equal(stripAnsi('Task #42 created'), 'Task #42 created');
  });

  it('strips codes from real tool output', () => {
    const input = '\x1b[32m✔\x1b[0m Test passed\n\x1b[31m✘\x1b[0m Test failed';
    assert.equal(stripAnsi(input), '✔ Test passed\n✘ Test failed');
  });

  it('strips multiple codes in sequence', () => {
    assert.equal(stripAnsi('\x1b[1m\x1b[31m\x1b[4mtext\x1b[0m'), 'text');
  });
});
