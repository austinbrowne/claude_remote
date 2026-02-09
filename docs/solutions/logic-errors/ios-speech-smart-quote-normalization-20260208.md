---
title: "iOS speech recognition produces curly quotes that break string matching"
module: ClaudeRemote iOS
date: 2026-02-08
problem_type: logic_error
component: service
symptoms:
  - "Stop command 'that's all' not recognized when spoken via iOS speech recognition"
  - "SFSpeechRecognizer outputs Unicode curly quotes instead of straight apostrophes"
  - "String equality comparison silently fails on visually identical text"
root_cause: encoding_error
resolution_type: code_fix
severity: medium
language: swift
tags: [ios, speech-recognition, unicode, smart-quotes, curly-apostrophe, string-matching, locale, normalization, sfspeechrecognizer]
related_solutions:
  - "concurrency-issues/trigger-word-phase5-audio-arbitration"
---

# iOS Speech Recognition Smart Quote Normalization

## Problem Statement

The voice loop stop command "that's all" was not recognized when spoken through iOS speech recognition. The transcript appeared correct visually, but string comparison against the constant `"that's all"` (straight apostrophe `U+0027`) failed because `SFSpeechRecognizer` outputs `"that\u{2019}s all"` (right single curly quote `U+2019`).

## Environment

- iOS 18 / Swift 6
- `SFSpeechRecognizer` with both on-device and server-based recognition
- VoicePromptMatcher utility for matching voice transcripts

## Symptoms

1. User says "that's all" to exit voice loop
2. Transcript correctly shows "that's all" in UI (curly and straight quotes look identical in most fonts)
3. `isStopCommand()` returns `false`
4. Voice loop continues instead of stopping
5. No error or warning — silent failure

## Root Cause

iOS `SFSpeechRecognizer` produces typographic (smart) quotes in its output:

| Character | Unicode | Name | Source |
|-----------|---------|------|--------|
| `'` | `U+0027` | Apostrophe (straight) | Keyboard input, code literals |
| `'` | `U+2018` | Left single quotation mark | iOS speech recognition |
| `'` | `U+2019` | Right single quotation mark (curly apostrophe) | iOS speech recognition (most common) |

The stop phrase constant uses `U+0027` (straight apostrophe). Direct string comparison with `==` or `.contains()` fails because these are different Unicode code points, even though they render identically in most typefaces.

## What Didn't Work

- **`localizedCaseInsensitiveContains`** — handles case but not Unicode quote normalization
- **Unicode canonical decomposition (`precomposedStringWithCanonicalMapping`)** — smart quotes are not decomposed forms of straight quotes; they're entirely different characters

## Solution

Added `normalizeForComparison()` that explicitly replaces smart quotes and uses locale-invariant lowercasing:

```swift
// VoicePromptMatcher.swift
private static func normalizeForComparison(_ text: String) -> String {
    text.trimmingCharacters(in: .whitespacesAndNewlines)
        .lowercased(with: Locale(identifier: "en"))
        .replacingOccurrences(of: "\u{2018}", with: "'") // left single quote
        .replacingOccurrences(of: "\u{2019}", with: "'") // right single quote
}

public static func isStopCommand(_ transcript: String) -> Bool {
    let cleaned = normalizeForComparison(transcript)
    return !cleaned.isEmpty && stopPhrases.contains(cleaned)
}
```

Tests covering the edge cases:

```swift
@Test("curly apostrophe is a stop command (iOS speech produces these)")
func curlyApostropheThatsAll() {
    #expect(VoicePromptMatcher.isStopCommand("that\u{2019}s all") == true)
}

@Test("left single quote is a stop command")
func leftQuoteThatsAll() {
    #expect(VoicePromptMatcher.isStopCommand("that\u{2018}s all") == true)
}

@Test("locale-invariant lowercasing")
func allCapsStopListening() {
    #expect(VoicePromptMatcher.isStopCommand("STOP LISTENING") == true)
}
```

## Why This Works

- **Explicit replacement** is reliable — no ambiguity about which characters map to what
- **Locale-invariant lowercasing** (`Locale(identifier: "en")`) prevents Turkish İ→i issues where `"I".lowercased()` produces `"ı"` (dotless i) in Turkish locale
- **Centralized normalization** — all transcript comparisons go through the same function
- **Constants use straight quotes** — easy to type in code, normalized at comparison time

## Prevention Strategies

| Pattern | Why | How |
|---------|-----|-----|
| Normalize speech output before comparison | Speech engines produce locale-specific Unicode | Centralized normalization function |
| Test with actual speech output characters | Straight quotes in test literals miss the bug | Use `\u{2019}` explicitly in test strings |
| Use locale-invariant lowercasing | `.lowercased()` is locale-dependent | `.lowercased(with: Locale(identifier: "en"))` |
| Document Unicode gotchas in code comments | Smart quotes are invisible in most editors | Comment with Unicode code points |

## Common Pitfalls

| Pitfall | Consequence | Prevention |
|---------|-------------|------------|
| Using `==` on speech transcripts directly | Curly quotes silently fail matching | Always normalize before comparison |
| Assuming `.lowercased()` is universal | Turkish locale produces different output | Specify English locale explicitly |
| Testing with keyboard-typed apostrophes only | Tests pass but real speech input fails | Include `\u{2019}` in test cases |
| Relying on Unicode normalization forms (NFC/NFD) | Smart quotes aren't normalization variants | Explicit character replacement |
| Only replacing `U+2019` (right curly) | `U+2018` (left curly) also appears in some contexts | Replace both directions |

## Related Documentation

- [Apple SFSpeechRecognizer docs](https://developer.apple.com/documentation/speech/sfspeechrecognizer)
- [Unicode Quotation Marks](https://www.unicode.org/charts/PDF/U2000.pdf) — General Punctuation block
- [Phase 5: Trigger Word Audio Arbitration](../concurrency-issues/trigger-word-phase5-audio-arbitration.md) — trigger word detection context
