// ============================================
// Initialization
// ============================================

function loadSettings() {
  document.getElementById('ttsEnabled').checked = settings.ttsEnabled;
  document.getElementById('speakTools').checked = settings.speakTools;
  document.getElementById('speechRate').value = settings.speechRate.toString();
  document.getElementById('notifyEnabled').checked = settings.notifyEnabled;
  document.getElementById('debugEnabled').checked = debugMode;
  updateTTSButton();
}

function initVoices() {
  const populateVoices = () => {
    const voices = synth.getVoices();
    const select = document.getElementById('voiceSelect');
    select.innerHTML = '<option value="default">System Default</option>';

    voices.forEach(voice => {
      const option = document.createElement('option');
      option.value = voice.voiceURI;
      option.textContent = `${voice.name} (${voice.lang})`;
      if (voice.voiceURI === settings.voiceURI) option.selected = true;
      select.appendChild(option);
    });
  };

  populateVoices();
  if (speechSynthesis.onvoiceschanged !== undefined) {
    speechSynthesis.onvoiceschanged = populateVoices;
  }
}

function initSpeechRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    document.getElementById('voiceBtn').style.display = 'none';
    return;
  }

  recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  recognition.onresult = (event) => {
    const input = document.getElementById('commandInput');
    let finalTranscript = '';
    let interimTranscript = '';

    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) {
        finalTranscript += event.results[i][0].transcript;
      } else {
        interimTranscript += event.results[i][0].transcript;
      }
    }

    // Check if this is a response to a prompt
    if (finalTranscript && currentPrompt && handleVoicePromptResponse(finalTranscript)) {
      return; // Handled as prompt response
    }

    input.value = finalTranscript || interimTranscript;
    autoResize(input);
  };

  recognition.onend = () => {
    isRecording = false;
    document.getElementById('voiceBtn').classList.remove('recording');
  };

  recognition.onerror = (event) => {
    console.error('Speech recognition error:', event.error);
    isRecording = false;
    document.getElementById('voiceBtn').classList.remove('recording');
    if (event.error !== 'no-speech') {
      showToast('Voice input error', 'error');
    }
  };
}

function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    // Will request when user enables notifications in settings
  }
}

// Viewport handling for keyboard
function setupViewportHandling() {
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', adjustPromptCardPosition);
  }
}

function adjustPromptCardPosition() {
  const card = document.getElementById('promptCard');
  if (!card.classList.contains('show')) return;

  const viewport = window.visualViewport;
  if (viewport) {
    const keyboardHeight = window.innerHeight - viewport.height;
    if (keyboardHeight > 100) {
      // Keyboard is visible
      card.style.bottom = (keyboardHeight + 10) + 'px';
    } else {
      card.style.bottom = '180px';
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  if (authToken) {
    document.getElementById('token').value = authToken;
    connect();
  }

  initVoices();
  initSpeechRecognition();
  loadSettings();
  requestNotificationPermission();

  // Detect when user returns from background (iOS Safari frozen socket fix)
  document.addEventListener('visibilitychange', handleVisibilityChange);

  // Event delegation for tool expand/collapse (XSS-safe)
  document.getElementById('outputArea').addEventListener('click', (e) => {
    const summary = e.target.closest('.tool-summary');
    if (summary) {
      const lang = summary.dataset.lang || 'plaintext';
      toggleToolExpand(summary.parentElement, lang);
    }
  });

  // Event delegation for autocomplete selection (XSS-safe)
  document.getElementById('autocomplete').addEventListener('click', (e) => {
    const item = e.target.closest('.autocomplete-item');
    if (item && item.dataset.cmd) {
      selectAutocomplete(item.dataset.cmd);
    }
  });

  // Setup mobile session drawer swipe gesture
  setupSessionDrawerSwipe();

  // Initialize viewport handling
  setupViewportHandling();
  adjustPromptCardPosition();
});
