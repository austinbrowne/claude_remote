// ============================================
// Initialization
// ============================================

function loadSettings() {
  document.getElementById('ttsEnabled').checked = settings.ttsEnabled;
  document.getElementById('speakTools').checked = settings.speakTools;
  document.getElementById('speechRate').value = settings.speechRate.toString();
  document.getElementById('notifyEnabled').checked = settings.notifyEnabled;
  document.getElementById('debugEnabled').checked = debugMode;
  document.getElementById('triggerEnabled').checked = settings.triggerEnabled;
  updateTTSButton();

  // Auto-start trigger mode if it was previously enabled
  if (settings.triggerEnabled && recognition) {
    enableTriggerMode();
  }
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
    let finalTranscript = '';
    let interimTranscript = '';

    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) {
        finalTranscript += event.results[i][0].transcript;
      } else {
        interimTranscript += event.results[i][0].transcript;
      }
    }

    const fullText = finalTranscript || interimTranscript;

    // Priority 1: Prompt response (always takes precedence)
    if (finalTranscript && currentPrompt && handleVoicePromptResponse(finalTranscript)) {
      return;
    }

    // Priority 2: Trigger word capturing (accumulate command)
    if (triggerState === TRIGGER_STATE.CAPTURING) {
      if (finalTranscript) {
        // Check for cancel/stop
        const lower = finalTranscript.toLowerCase().trim();
        if (lower === 'cancel' || lower === 'stop') {
          triggerCommandBuffer = '';
          triggerState = TRIGGER_STATE.IDLE;
          if (triggerSilenceTimer) { clearTimeout(triggerSilenceTimer); triggerSilenceTimer = null; }
          try { recognition.stop(); } catch (e) {}
          isRecording = false;
          // Re-enable listening after pause
          if (settings.triggerEnabled) {
            setTimeout(() => {
              if (settings.triggerEnabled && triggerState === TRIGGER_STATE.IDLE) {
                triggerState = TRIGGER_STATE.LISTENING;
                recognition.continuous = !isIOS;
                try { recognition.start(); } catch (e) {}
                updateTriggerUI();
              }
            }, TRIGGER_RESTART_DELAY_MS);
          }
          updateTriggerUI();
          showToast('Cancelled', 'success');
          document.getElementById('commandInput').value = '';
          autoResize(document.getElementById('commandInput'));
          return;
        }
        triggerCommandBuffer += ' ' + finalTranscript;
      }
      // Show interim preview
      const input = document.getElementById('commandInput');
      input.value = (triggerCommandBuffer + ' ' + interimTranscript).trim();
      autoResize(input);
      resetTriggerSilenceTimer();
      return;
    }

    // Priority 3: Trigger word detection (scanning for "titus" + variants)
    if (triggerState === TRIGGER_STATE.LISTENING) {
      const lower = fullText.toLowerCase();

      // Debug: show what's being heard
      if (debugMode && fullText.trim()) {
        showToast('Heard: ' + fullText.trim().substring(0, 40), 'info');
      }

      // Check all trigger variants
      for (const variant of TRIGGER_VARIANTS) {
        const idx = lower.indexOf(variant);
        if (idx !== -1) {
          const afterTrigger = fullText.substring(idx + variant.length).trim();
          startTriggerCapture(afterTrigger);
          return;
        }
      }
      // Still listening, don't put text in input
      return;
    }

    // Priority 4: Normal manual voice input
    const input = document.getElementById('commandInput');
    input.value = fullText;
    autoResize(input);
  };

  recognition.onend = () => {
    isRecording = false;
    document.getElementById('voiceBtn').classList.remove('recording');

    // Auto-restart for trigger listening (both LISTENING and CAPTURING states)
    if (triggerState !== TRIGGER_STATE.IDLE) {
      setTimeout(() => {
        if (triggerState !== TRIGGER_STATE.IDLE) {
          try { recognition.start(); } catch (e) {}
        }
      }, TRIGGER_RESTART_DELAY_MS);
    }
  };

  recognition.onerror = (event) => {
    console.error('Speech recognition error:', event.error);
    isRecording = false;
    document.getElementById('voiceBtn').classList.remove('recording');

    // Restart trigger listening on no-speech timeout (Kieran's fix)
    if (event.error === 'no-speech' && triggerState !== TRIGGER_STATE.IDLE) {
      setTimeout(() => {
        if (triggerState !== TRIGGER_STATE.IDLE) {
          try { recognition.start(); } catch (e) {}
        }
      }, TRIGGER_RESTART_DELAY_MS);
      return;
    }

    if (event.error !== 'no-speech' && event.error !== 'aborted') {
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
