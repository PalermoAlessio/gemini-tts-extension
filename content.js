// content.js - Shadow DOM Implementation & Robust Communication - IMPROVED

let state = {
  text: '',
  playing: false,
  loading: false,
  time: 0,
  speed: 1.0,
  duration: 0,
  error: null,
};

// 1. Crea un elemento "host" per lo Shadow DOM
const hostElement = document.createElement('div');
hostElement.id = 'tts-extension-host';
document.body.appendChild(hostElement);

// 2. Allega lo Shadow Root
const shadowRoot = hostElement.attachShadow({ mode: 'open' });

// 3. Crea l'HTML della UI
const uiContainer = document.createElement('div');
uiContainer.innerHTML = `
<div id="tts-floating-bar">
<div id="errorMessage"></div>
<div class="pill-container">
<button id="skipBack" title="Skip Back">⏪</button>
<button id="playPause" title="Play/Pause">▶️</button>
<button id="skipForward" title="Skip Forward">⏩</button>
<input type="range" id="speed" min="0.5" max="2" step="0.1" value="1" title="Playback Speed">
<span id="speedValue">1.0x</span>
<button id="closeBar" title="Close">✕</button>
</div>
<div class="progress-container">
<div id="progressBar"></div>
</div>
<div id="timeDisplay">0:00 / 0:00</div>
</div>
`;

// 4. Inietta il CSS nello Shadow DOM
const styleLink = document.createElement('link');
styleLink.rel = 'stylesheet';
styleLink.href = chrome.runtime.getURL('content.css');
shadowRoot.appendChild(styleLink);

// 5. Aggiungi la UI allo Shadow DOM
shadowRoot.appendChild(uiContainer);

// Nascondi l'host inizialmente
hostElement.style.display = 'none';

// --- Riferimenti agli elementi della UI (all'interno dello Shadow DOM) ---
const bar = shadowRoot.getElementById('tts-floating-bar');
const playPauseBtn = shadowRoot.getElementById('playPause');
const speedInput = shadowRoot.getElementById('speed');
const speedValueSpan = shadowRoot.getElementById('speedValue');
const progressBar = shadowRoot.getElementById('progressBar');
const timeDisplay = shadowRoot.getElementById('timeDisplay');
const errorMessageDiv = shadowRoot.getElementById('errorMessage');

// --- Funzioni UI ---

function formatTime(seconds) {
  const minutes = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${minutes}:${secs}`;
}

function updateUI() {
  // MIGLIORATO: Mostra icona appropriata per stato audio
  if (state.loading) {
    playPauseBtn.textContent = '...'; // Indicatore di caricamento
    playPauseBtn.disabled = true;
  } else if (state.playing) {
    playPauseBtn.textContent = '⏸️'; // Pausa
    playPauseBtn.disabled = false;
  } else if (state.time === 0 && state.duration > 0) {
    playPauseBtn.textContent = '🔄'; // Replay (audio finito)
    playPauseBtn.disabled = false;
    playPauseBtn.title = 'Replay from beginning';
  } else {
    playPauseBtn.textContent = '▶️'; // Play normale
    playPauseBtn.disabled = false;
    playPauseBtn.title = 'Play/Pause';
  }

  speedInput.value = state.speed;
  speedValueSpan.textContent = `${state.speed.toFixed(1)}x`;

  const progress = state.duration > 0 ? (state.time / state.duration) * 100 : 0;
  progressBar.style.width = `${progress}%`;

  timeDisplay.textContent = `${formatTime(state.time)} / ${formatTime(state.duration)}`;

  if (state.error) {
    errorMessageDiv.textContent = state.error;
    errorMessageDiv.style.display = 'block';
  } else {
    errorMessageDiv.style.display = 'none';
  }
}

// --- Gestione Eventi UI ---

playPauseBtn.addEventListener('click', () => {
  if (!playPauseBtn.disabled) {
    // Sempre invia play/pause - il background e offscreen decidono se è resume o replay
    const action = state.playing ? 'pause' : 'play';
    console.log(`[CS] Sending ${action} action (time: ${state.time}, duration: ${state.duration})`);
    chrome.runtime.sendMessage({ action });
  }
});

shadowRoot.getElementById('skipBack').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'skip', value: Math.max(0, state.time - 10) });
});

shadowRoot.getElementById('skipForward').addEventListener('click', () => {
  chrome.runtime.sendMessage({ action: 'skip', value: Math.min(state.duration, state.time + 10) });
});

speedInput.addEventListener('input', () => {
  const newSpeed = parseFloat(speedInput.value);
  chrome.runtime.sendMessage({ action: 'speed', value: newSpeed });
});

shadowRoot.getElementById('closeBar').addEventListener('click', () => {
  hostElement.style.display = 'none';
  // IMPROVED: Invia messaggio di stop al background
  chrome.runtime.sendMessage({ action: 'stopAudio' });
});

// --- Logica di Drag and Drop (opera sull'hostElement) ---
let isDragging = false;
let offsetX, offsetY;

bar.addEventListener('mousedown', (e) => {
  isDragging = true;
  offsetX = e.clientX - hostElement.getBoundingClientRect().left;
  offsetY = e.clientY - hostElement.getBoundingClientRect().top;
  bar.style.cursor = 'grabbing';
});

document.addEventListener('mousemove', (e) => {
  if (isDragging) {
    hostElement.style.left = `${e.clientX - offsetX}px`;
    hostElement.style.top = `${e.clientY - offsetY}px`;
  }
});

document.addEventListener('mouseup', () => {
  isDragging = false;
  bar.style.cursor = 'grab';
});

// --- IMPROVED: Comunicazione con il Background Script ---

// IMPROVED: Helper per inviare messaggi con gestione errori
function sendMessageToBackground(message, retries = 2) {
  return new Promise((resolve) => {
    const attemptSend = (attempt) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            console.warn(`[CS] Error sending message (attempt ${attempt}):`, chrome.runtime.lastError.message);
            if (attempt < retries) {
              setTimeout(() => attemptSend(attempt + 1), 100);
            } else {
              console.error(`[CS] Failed to send message after ${retries + 1} attempts:`, message);
              resolve(null);
            }
          } else {
            resolve(response);
          }
        });
      } catch (error) {
        console.error(`[CS] Exception sending message:`, error);
        resolve(null);
      }
    };
    attemptSend(0);
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[CS] Received message:', message.action);

  // Handle ping message for handshake
  if (message.action === 'ping') {
    sendResponse({ ok: true });
    return; // No need for async return true here
  }

  switch (message.action) {
    case 'updateState':
      Object.assign(state, message.state);
      if (state.text && state.text.trim() !== '') {
        hostElement.style.display = 'block';
      }
      updateUI();
      break;

    case 'timeUpdate':
      state.time = message.time;
      updateUI();
      break;

    case 'updateDuration':
      state.duration = message.duration;
      updateUI();
      break;

    case 'error':
      state.error = message.message;
      state.loading = false;
      state.playing = false;
      updateUI();

      // IMPROVED: Mostra l'UI anche in caso di errore
      if (state.error) {
        hostElement.style.display = 'block';
      }

      // Nascondi l'errore dopo qualche secondo
      setTimeout(() => {
        state.error = null;
        updateUI();
        // Se non c'è testo, nascondi anche la UI
        if (!state.text || state.text.trim() === '') {
          hostElement.style.display = 'none';
        }
      }, 5000);
      break;

    default:
      console.warn('[CS] Unknown message action:', message.action);
  }
  // No return true here, as these messages don't require an async response
});

// IMPROVED: Richiedi lo stato iniziale al caricamento della pagina
(async () => {
  try {
    console.log('[CS] Requesting initial state from background');
    const initialState = await sendMessageToBackground({ action: 'getState' });
    if (initialState && Object.keys(initialState).length > 0) {
      console.log('[CS] Received initial state:', initialState);
      Object.assign(state, initialState);
      if (state.text && state.text.trim() !== '') {
        hostElement.style.display = 'block';
        updateUI();
      }
    } else {
      console.log('[CS] No initial state received or state is empty');
    }
  } catch (e) {
    console.warn('[CS] Could not get initial state:', e.message);
  }
})();

// IMPROVED: Gestione migliore della visibilità della pagina
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && state.playing) {
    // La pagina è nascosta ma l'audio sta suonando - mantieni la UI visibile
    console.log('[CS] Page hidden but audio playing, keeping UI visible');
  }
});

console.log('[CS] Content script loaded and ready');
