// ============================================
// Constants
// ============================================
const PING_TIMEOUT_MS = 3000;              // Pong response timeout before reconnect
const TOAST_DURATION_MS = 2500;            // Toast message display duration
const PERMISSION_CARD_DELAY_MS = 500;      // Delay before showing permission card
const VOICE_LISTEN_DELAY_MS = 500;         // Delay before starting voice recognition after TTS

// ============================================
// State
// ============================================
let reconnectTimeout = null;
let reconnectAttempts = 0;
let pingTimeout = null;
let pingInterval = null;
const PING_INTERVAL_MS = 15000;           // Heartbeat every 15 seconds
const MAX_RECONNECT_DELAY = 30000;
let toastTimeout = null;
let ws = null;
let currentSessionId = null;
// Session switch state machine to prevent race conditions
const SESSION_STATE = { IDLE: 0, SWITCHING: 1, ACTIVE: 2 };
let sessionState = SESSION_STATE.IDLE;
let pendingSessionId = null;
let pendingPromptMessage = null;  // Queue for prompts arriving during state transitions
let isRecording = false;
let recognition = null;
let synth = window.speechSynthesis;
let currentUtterance = null;
let speakingMessageElement = null; // Track currently highlighted message for TTS

// ============================================
// Trigger Word State
// ============================================
const TRIGGER_STATE = { IDLE: 0, LISTENING: 1, CAPTURING: 2 };
let triggerState = TRIGGER_STATE.IDLE;
let triggerCommandBuffer = '';
let triggerSilenceTimer = null;
const TRIGGER_SILENCE_MS = 3000;    // 3s silence = auto-send
const TRIGGER_RESTART_DELAY_MS = 300;
const TRIGGER_WORD = 'titus';
const TRIGGER_VARIANTS = ['titus', 'tightest', 'tidus', 'tidas', 'titus,', 'titis', 'titus.', 'tight us', 'title', 'titus!'];
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

// Safe storage access (handles private browsing mode)
function safeGetItem(storage, key, fallback = null) {
  try {
    return storage.getItem(key);
  } catch (e) {
    console.warn('Storage unavailable:', e.message);
    return fallback;
  }
}
function safeSetItem(storage, key, value) {
  try {
    storage.setItem(key, value);
  } catch (e) {
    console.warn('Storage unavailable:', e.message);
  }
}
function safeRemoveItem(storage, key) {
  try {
    storage.removeItem(key);
  } catch (e) {
    console.warn('Storage unavailable:', e.message);
  }
}

let authToken = safeGetItem(localStorage, 'claude_remote_token', '');
let settings = {
  ttsEnabled: safeGetItem(localStorage, 'tts_enabled') === 'true',
  speakTools: safeGetItem(localStorage, 'speak_tools') === 'true',
  voiceURI: safeGetItem(localStorage, 'voice_uri', 'default'),
  speechRate: parseFloat(safeGetItem(localStorage, 'speech_rate')) || 1,
  notifyEnabled: safeGetItem(localStorage, 'notify_enabled') === 'true',
  triggerEnabled: safeGetItem(localStorage, 'trigger_enabled') === 'true'
};
const MAX_MESSAGES = 500;
const recentUserMessages = new Map(); // Track recently sent messages to dedupe: normalized content -> timestamp

// Normalize content for deduplication (handle whitespace/encoding differences)
function normalizeForDedup(content) {
  if (typeof content !== 'string') content = JSON.stringify(content);
  return content.trim().replace(/\s+/g, ' ');
}

// Add message to dedup tracker (expires after 10 seconds)
function trackSentMessage(content) {
  const key = normalizeForDedup(content);
  recentUserMessages.set(key, Date.now());
  // Cleanup old entries
  const now = Date.now();
  for (const [k, t] of recentUserMessages) {
    if (now - t > 10000) recentUserMessages.delete(k);
  }
}

// Check if message should be deduped
function shouldDedupeMessage(content) {
  const key = normalizeForDedup(content);
  if (recentUserMessages.has(key)) {
    recentUserMessages.delete(key);
    return true;
  }
  return false;
}

// Pending operations (avoid window object pollution)
const pending = {
  reconnectSession: null,      // Session to rewatch after reconnect
  permissionCard: null,        // { tool, cmd, isDestructive }
  permissionTimeout: null,     // Timeout ID for permission card delay
  lastPermissionCardTime: 0,   // Timestamp of last permission card shown
  lastToolLanguage: 'plaintext' // Last tool language for syntax highlighting
};

// Active subagents: agentId -> { status, startTime, description, lastActivity }
const activeSubagents = new Map();
// Pending subagent permissions: agentId -> { timeout, card }
const pendingSubagentPermissions = new Map();

// ============================================
// Reconnection State
// ============================================
let lastVisibleTime = Date.now();
// Track the last sent command to detect stale replays from iOS form restoration
let lastSentCommand = { text: '', timestamp: 0 };

// ============================================
// Debug State
// ============================================
let debugMsgCount = 0;
let debugMode = localStorage.getItem('debug_mode') === 'true';

// ============================================
// Session Drawer State
// ============================================
function isMobile() {
  return window.matchMedia('(pointer: coarse)').matches;
}

let drawerOpen = false;

// ============================================
// Escape HTML
// ============================================
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// ============================================
// Utilities
// ============================================
function showToast(message, type = '') {
  if (toastTimeout) {
    clearTimeout(toastTimeout);
    toastTimeout = null;
  }
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast show ${type}`;
  toastTimeout = setTimeout(() => {
    toast.className = 'toast';
    toastTimeout = null;
  }, TOAST_DURATION_MS);
}
