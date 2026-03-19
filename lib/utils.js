const crypto = require('crypto');

// Claude Code spinner verbs (from tengu_spinner_words)
// These are the 90 verbs Claude Code randomly displays while processing
const SPINNER_VERBS = [
  'Accomplishing', 'Actioning', 'Actualizing', 'Baking', 'Booping', 'Brewing',
  'Calculating', 'Cerebrating', 'Channelling', 'Churning', 'Clauding', 'Coalescing',
  'Cogitating', 'Combobulating', 'Computing', 'Concocting', 'Conjuring', 'Considering',
  'Contemplating', 'Cooking', 'Crafting', 'Creating', 'Crunching', 'Deciphering',
  'Deliberating', 'Determining', 'Discombobulating', 'Divining', 'Doing', 'Effecting',
  'Elucidating', 'Enchanting', 'Envisioning', 'Finagling', 'Flibbertigibbeting', 'Forging',
  'Forming', 'Frolicking', 'Generating', 'Germinating', 'Hatching', 'Herding', 'Honking',
  'Hustling', 'Ideating', 'Imagining', 'Incubating', 'Inferring', 'Jiving', 'Manifesting',
  'Marinating', 'Meandering', 'Moseying', 'Mulling', 'Mustering', 'Musing', 'Noodling',
  'Percolating', 'Perusing', 'Philosophising', 'Pondering', 'Pontificating', 'Processing',
  'Puttering', 'Puzzling', 'Reticulating', 'Ruminating', 'Scheming', 'Schlepping', 'Shimmying',
  'Shucking', 'Simmering', 'Smooshing', 'Spelunking', 'Spinning', 'Stewing', 'Sussing',
  'Synthesizing', 'Thinking', 'Tinkering', 'Transmuting', 'Unfurling', 'Unravelling', 'Vibing',
  'Wandering', 'Whirring', 'Wibbling', 'Wizarding', 'Working', 'Wrangling'
];

const MAX_READ_SIZE = 1024 * 1024; // 1MB max per read
const HISTORY_LINE_LIMIT = 100; // Max history lines to send on session load

// Model context window sizes (in tokens)
// Used to calculate context usage percentage from token counts
const MODEL_CONTEXT_WINDOWS = {
  'claude-opus-4-6':        1000000,
  'claude-opus-4-5':        200000,
  'claude-sonnet-4-6':      200000,
  'claude-sonnet-4-5':      200000,
  'claude-haiku-4-5':       200000,
  'claude-3-5-sonnet':      200000,
  'claude-3-5-haiku':       200000,
  'claude-3-opus':          200000,
  'claude-3-sonnet':        200000,
  'claude-3-haiku':         200000
};
const DEFAULT_CONTEXT_WINDOW = 200000;

/**
 * Get the context window size for a model ID.
 * Matches by prefix to handle versioned model IDs (e.g., claude-opus-4-6-20250101).
 */
function getContextWindow(modelId) {
  if (!modelId) return DEFAULT_CONTEXT_WINDOW;
  for (const [prefix, size] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (modelId.startsWith(prefix)) return size;
  }
  return DEFAULT_CONTEXT_WINDOW;
}

/**
 * Calculate context usage percentage from token usage and model.
 * Returns 0-100 integer, or null if insufficient data.
 */
function calculateContextPercentage(usage, modelId) {
  if (!usage) return null;
  const totalInput = (usage.input_tokens || 0) +
                     (usage.cache_read_input_tokens || 0) +
                     (usage.cache_creation_input_tokens || 0);
  if (totalInput === 0) return null;
  const window = getContextWindow(modelId);
  return Math.max(0, Math.min(Math.round((totalInput / window) * 100), 100));
}

// Structured error codes for agent-friendly error handling
const ErrorCodes = {
  RATE_LIMITED: 'RATE_LIMITED',
  UNAUTHORIZED: 'UNAUTHORIZED',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  INJECT_FAILED: 'INJECT_FAILED'
};

function getRandomSpinnerVerb() {
  return SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)];
}

// Strip ANSI escape codes from strings (tool output often contains terminal colors)
// Covers CSI sequences (\x1b[...X), OSC sequences (\x1b]...BEL/ST), and charset selection (\x1b(X)
function stripAnsi(str) {
  return str.replace(/\x1b(?:\[[0-9;]*[a-zA-Z]|\].*?(?:\x07|\x1b\\)|\([A-B])/g, '');
}

// Format MCP tool names for readability
// mcp__github__create_issue -> GitHub: create_issue
function formatMcpToolName(name) {
  const parts = name.split('__');
  if (parts.length >= 3) {
    const server = parts[1].charAt(0).toUpperCase() + parts[1].slice(1);
    return `${server}: ${parts.slice(2).join('_')}`;
  }
  return name;
}

// Redact sensitive fields from MCP tool inputs
function sanitizeMcpInput(input) {
  if (!input) return {};
  const safe = { ...input };
  const sensitiveKeys = ['password', 'token', 'secret', 'key', 'auth', 'credential'];
  for (const key of Object.keys(safe)) {
    if (sensitiveKeys.some(s => key.toLowerCase().includes(s))) {
      safe[key] = '[REDACTED]';
    }
  }
  return safe;
}

function sendError(ws, code, message, details = {}) {
  ws.send(JSON.stringify({
    type: 'error',
    code,
    message,
    details
  }));
}

// Timing-safe token comparison to prevent timing attacks
function secureCompare(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

module.exports = {
  SPINNER_VERBS,
  MAX_READ_SIZE,
  HISTORY_LINE_LIMIT,
  ErrorCodes,
  MODEL_CONTEXT_WINDOWS,
  DEFAULT_CONTEXT_WINDOW,
  getRandomSpinnerVerb,
  getContextWindow,
  calculateContextPercentage,
  stripAnsi,
  formatMcpToolName,
  sanitizeMcpInput,
  sendError,
  secureCompare
};
