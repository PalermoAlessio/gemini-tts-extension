// background.js - Robust Communication & State Management - FIXED

// --- GESTIONE DOCUMENTO OFFSCREEN ---

let creatingOffscreenPromise = null; // Promise-based lock

async function hasOffscreenDocument() {
  try {
    if (chrome.runtime.getContexts) {
      const existingContexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      return existingContexts.length > 0;
    }
    return false;
  } catch (error) {
    console.error("[BG] Error checking offscreen contexts:", error);
    return false;
  }
}

async function setupOffscreen() {
  if (await hasOffscreenDocument()) {
    return;
  }

  if (creatingOffscreenPromise) {
    await creatingOffscreenPromise;
    return;
  }

  creatingOffscreenPromise = new Promise(async (resolve, reject) => {
    let readyListener = null;
    let timeoutId = null;

    const cleanup = () => {
      if (readyListener) {
        chrome.runtime.onMessage.removeListener(readyListener);
      }
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      creatingOffscreenPromise = null;
    };

    readyListener = (message) => {
      if (message.action === 'offscreenReady') {
        console.log("[BG] Offscreen document is ready.");
        cleanup();
        resolve();
      }
    };

    // Timeout di sicurezza per l'inizializzazione del documento offscreen
    timeoutId = setTimeout(() => {
      console.warn("[BG] Timeout waiting for offscreen ready signal");
      cleanup();
      reject(new Error('Timeout waiting for offscreen document to be ready'));
    }, 5000);

    try {
      chrome.runtime.onMessage.addListener(readyListener);
      console.log("[BG] Creating offscreen document...");
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK],
        justification: 'Play TTS audio in a DOM context'
      });

      // Verifica che il documento sia stato effettivamente creato
      if (!(await hasOffscreenDocument())) {
        throw new Error('Offscreen document was not created successfully');
      }

    } catch (error) {
      console.error("[BG] Error creating offscreen document:", error);
      cleanup();
      reject(error);
    }
  });

  await creatingOffscreenPromise;
}

// --- FUNZIONI DI UTILITÀ PER LA COMUNICAZIONE ROBUSTA ---

async function sendToTab(tabId, message, timeoutMs = 4000) {
  console.log(`[BG] Sending to tab ${tabId} action: ${message.action}`);

  // Verifica prima che il tab esista ancora
  try {
    await chrome.tabs.get(tabId);
  } catch (e) {
    console.warn(`[BG] Tab ${tabId} no longer exists, skipping message`);
    return null;
  }

  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        reject(new Error(`Timeout waiting for response from tab ${tabId} for action ${message.action}`));
      }
    }, timeoutMs);

    try {
      chrome.tabs.sendMessage(tabId, message, (response) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const lastErr = chrome.runtime.lastError;
        if (lastErr) {
          // Se è il classico "Receiving end..." non rigettare duro: restituisci null per triggerare reiniezione
          if (/Receiving end does not exist/.test(lastErr.message) ||
            /message port closed/.test(lastErr.message)) {
            console.warn(`[BG] Communication lost with tab ${tabId} for action ${message.action}`);
          resolve(null); // Segnala al chiamante che deve reiniettare
            } else {
              reject(lastErr);
            }
        } else {
          resolve(response);
        }
      });
    } catch (e) {
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(e);
      }
    }
  });
}

// FIXED: Migliorata gestione errori per sendToOffscreen
async function sendToOffscreen(message, timeoutMs = 4000) {
  console.log(`[BG] Sending to offscreen action: ${message.action}`);

  // Verifica prima se il documento offscreen esiste
  if (!(await hasOffscreenDocument())) {
    console.warn(`[BG] No offscreen document available for action: ${message.action}`);
    return null;
  }

  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        reject(new Error('Timeout waiting for response from offscreen for action ' + message.action));
      }
    }, timeoutMs);

    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const lastErr = chrome.runtime.lastError;
        if (lastErr) {
          // Gestisci specificamente l'errore di connessione persa
          if (/Receiving end does not exist/.test(lastErr.message) ||
            /message port closed/.test(lastErr.message)) {
            console.warn(`[BG] Offscreen connection lost for action: ${message.action}`);
          resolve(null);
            } else {
              reject(lastErr);
            }
        } else {
          resolve(response);
        }
      });
    } catch (e) {
      if (!done) {
        done = true;
        clearTimeout(timer);
        reject(e);
      }
    }
  });
}

async function injectContentScript(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || !/^https?:/.test(tab.url)) {
      console.warn(`[BG] Cannot inject content script into unsupported URL: ${tab?.url}`);
      return false;
    }
    console.log(`[BG] Injecting content.js into tab ${tabId}`);
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js']
    });
    return true;
  } catch (e) {
    console.error(`[BG] Failed to inject content script into tab ${tabId}:`, e);
    return false;
  }
}

async function ensureTabReady(tabId) {
  try {
    // Prova un ping più lungo per dare tempo al content script di caricare
    const resp = await sendToTab(tabId, { action: 'ping' }, 2000);
    return resp && resp.ok;
  } catch (e) {
    console.log(`[BG] Ping to tab ${tabId} failed: ${e.message}`);
    return false;
  }
}

// --- LOGICA DI BUSINESS ---

async function getApiKey() {
  const data = await chrome.storage.local.get('apiKey');
  if (!data.apiKey) {
    throw new Error('API key is not set. Please set it in the extension options.');
  }
  return data.apiKey;
}

async function generateTTS(text) {
  const apiKey = await getApiKey();
  const ttsModelEndpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent';

  // STRATEGIA SEMPLIFICATA: Usa solo la configurazione che funziona
  const requestBody = {
    contents: [{
      parts: [{ text: text }]
    }],
    generationConfig: {
      responseModalities: ['AUDIO']
    }
  };

  try {
    console.log('[BG] Calling TTS API with simple config...');

    const response = await fetch(ttsModelEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },
      body: JSON.stringify(requestBody)
    });

    console.log('[BG] API Response status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      console.error('[BG] TTS API Error Response:', errorText);
      let errorData;
      try {
        errorData = JSON.parse(errorText);
      } catch (e) {
        errorData = { error: { message: errorText } };
      }
      throw new Error(`API error (${response.status}): ${errorData.error?.message || response.statusText}`);
    }

    const data = await response.json();
    console.log('[BG] API response received successfully');

    // Verifica struttura risposta
    if (!data.candidates || !Array.isArray(data.candidates) || data.candidates.length === 0) {
      console.error('[BG] No candidates in response');
      throw new Error('No candidates in API response');
    }

    const candidate = data.candidates[0];
    if (!candidate.content || !candidate.content.parts || !Array.isArray(candidate.content.parts)) {
      console.error('[BG] Invalid candidate structure');
      throw new Error('Invalid candidate structure in API response');
    }

    // Cerca la parte audio
    let audioBase64 = null;
    let mimeType = null;

    for (let i = 0; i < candidate.content.parts.length; i++) {
      const part = candidate.content.parts[i];

      if (part.inlineData && part.inlineData.data) {
        audioBase64 = part.inlineData.data;
        mimeType = part.inlineData.mimeType || 'unknown';
        console.log(`[BG] Found audio data, MIME type: ${mimeType}`);
        break;
      }
    }

    if (!audioBase64) {
      console.error('[BG] No audio data found');
      throw new Error('No audio data in API response');
    }

    console.log(`[BG] TTS generated successfully, audio size: ${audioBase64.length} chars, MIME: ${mimeType}`);

    return { audioBase64, mimeType };

  } catch (error) {
    console.error('[BG] TTS generation failed:', error);
    throw error;
  }
}

// --- GESTIONE DEGLI EVENTI E DELLO STATO ---

// Variabile per tracciare se c'è audio attivo
let activeAudioTabs = new Set();

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'read-text',
    title: 'Read selected text',
    contexts: ['selection'],
  });
});

async function handleReadTextAction(tabId, text) {
  if (!text || text.trim() === '') {
    try {
      await sendToTab(tabId, { action: 'error', message: 'No text selected' });
    } catch (e) {
      console.error(`[BG] Failed to send error to tab ${tabId}:`, e);
    }
    return;
  }

  console.log(`[BG] Starting TTS for tab ${tabId} with text length: ${text.length}`);

  // 1. Verifica che il tab esista e sia accessibile
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('moz-extension://')) {
      throw new Error('Cannot inject into system pages');
    }
    console.log(`[BG] Tab ${tabId} verified: ${tab.url}`);
  } catch (e) {
    console.error(`[BG] Tab ${tabId} is not accessible:`, e);
    return;
  }

  // 2. Setup lo stato di loading PRIMA di qualsiasi comunicazione
  const loadingState = {
    text,
    playing: false,
    loading: true,
    time: 0,
    speed: 1.0,
    duration: 0
  };
  await chrome.storage.session.set({ [tabId.toString()]: loadingState });
  console.log(`[BG] Loading state set for tab ${tabId}`);

  // 3. Assicurati che il content script sia pronto con retry migliorato
  let tabIsReady = false;
  let attempts = 0;
  const maxAttempts = 3;

  while (!tabIsReady && attempts < maxAttempts) {
    attempts++;
    console.log(`[BG] Tab readiness check attempt ${attempts}/${maxAttempts} for tab ${tabId}`);

    tabIsReady = await ensureTabReady(tabId);

    if (!tabIsReady) {
      console.log(`[BG] Tab ${tabId} not ready, attempting injection (attempt ${attempts})`);
      const injected = await injectContentScript(tabId);

      if (injected) {
        // Aspetta di più tra iniezione e verifica
        const waitTime = 1500 * attempts; // Attesa progressiva più lunga
        console.log(`[BG] Waiting ${waitTime}ms after injection...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));

        // Doppio check dopo iniezione
        tabIsReady = await ensureTabReady(tabId);
        if (!tabIsReady) {
          console.warn(`[BG] Tab ${tabId} still not ready after injection, waiting more...`);
          await new Promise(resolve => setTimeout(resolve, 1000));
          tabIsReady = await ensureTabReady(tabId);
        }
      } else {
        console.error(`[BG] Failed to inject script in tab ${tabId}`);
        break;
      }
    }
  }

  // 4. Se il tab non è pronto, procedi comunque con TTS ma senza UI
  let canCommunicateWithTab = tabIsReady;
  if (!tabIsReady) {
    console.warn(`[BG] Tab ${tabId} not ready after ${maxAttempts} attempts, proceeding without UI`);
    canCommunicateWithTab = false;
  } else {
    console.log(`[BG] Tab ${tabId} is ready, proceeding with full TTS`);
  }

  try {
    // 5. Invia stato di loading se possibile
    if (canCommunicateWithTab) {
      try {
        await sendToTab(tabId, { action: 'updateState', state: loadingState });
        console.log(`[BG] Loading state sent to tab ${tabId}`);
      } catch (e) {
        console.warn(`[BG] Failed to send loading state to tab ${tabId}:`, e);
        canCommunicateWithTab = false; // Disabilita comunicazione future
      }
    }

    // 6. Setup offscreen con retry
    let offscreenReady = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`[BG] Setting up offscreen document (attempt ${attempt}/3)`);
        await setupOffscreen();
        offscreenReady = true;
        break;
      } catch (error) {
        console.error(`[BG] Setup offscreen attempt ${attempt} failed:`, error);
        if (attempt < 3) {
          const waitTime = 1000 * Math.pow(2, attempt - 1);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
    }

    if (!offscreenReady) {
      throw new Error('Failed to setup offscreen document after 3 attempts');
    }

    // 7. Genera TTS
    console.log(`[BG] Generating TTS for text: "${text.substring(0, 100)}${text.length > 100 ? '...' : ''}"`);
    const { audioBase64, mimeType } = await generateTTS(text);

    // 8. Aggiorna stato finale
    const playingState = {
      text,
      playing: true,
      loading: false,
      time: 0,
      speed: 1.0,
      duration: 0
    };
    await chrome.storage.session.set({ [tabId.toString()]: playingState });
    console.log(`[BG] Playing state set for tab ${tabId}`);

    // 9. Invia audio all'offscreen con retry (includi mimeType se disponibile)
    let audioStarted = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`[BG] Sending audio to offscreen (attempt ${attempt}/3)`);
        await sendToOffscreen({
          target: 'offscreen',
          action: 'playAudio',
          tabId,
          audioBase64,
          speed: playingState.speed,
          mimeType: mimeType || 'unknown' // Passa il MIME type se disponibile
        });
        audioStarted = true;
        break;
      } catch (offscreenError) {
        console.error(`[BG] Failed to send audio to offscreen (attempt ${attempt}):`, offscreenError);
        if (attempt < 3) {
          const waitTime = 500 * attempt;
          await new Promise(resolve => setTimeout(resolve, waitTime));

          // Riprova setup offscreen se necessario
          if (!(await hasOffscreenDocument())) {
            try {
              console.log(`[BG] Recreating offscreen document for retry ${attempt + 1}`);
              await setupOffscreen();
            } catch (e) {
              console.error('[BG] Failed to recreate offscreen document:', e);
            }
          }
        }
      }
    }

    if (!audioStarted) {
      throw new Error('Failed to start audio playback after 3 attempts');
    }

    // 10. Traccia che questo tab ha audio attivo
    activeAudioTabs.add(tabId);
    console.log(`[BG] Audio started successfully for tab ${tabId}`);

    // 11. Aggiorna UI finale se possibile
    if (canCommunicateWithTab) {
      try {
        await sendToTab(tabId, { action: 'updateState', state: playingState });
        console.log(`[BG] Final state sent to tab ${tabId}`);
      } catch (e) {
        console.warn(`[BG] Failed to update final state for tab ${tabId}:`, e);
        // L'audio continuerà a suonare anche senza UI
      }
    } else {
      console.log(`[BG] Audio playing for tab ${tabId} but no UI communication available`);
    }

  } catch (error) {
    console.error('[BG] TTS Error:', error);

    // Rimuovi il loading state
    const errorState = {
      text: text || '',
      playing: false,
      loading: false,
      time: 0,
      speed: 1.0,
      duration: 0
    };
    await chrome.storage.session.set({ [tabId.toString()]: errorState });

    // Invia errore se possibile
    if (canCommunicateWithTab) {
      try {
        await sendToTab(tabId, { action: 'error', message: error.message });
        console.log(`[BG] Error sent to tab ${tabId}`);
      } catch (e) {
        console.warn(`[BG] Failed to send error to tab ${tabId}:`, e);
      }
    } else {
      console.log(`[BG] Error occurred but cannot communicate with tab ${tabId}: ${error.message}`);
    }
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'read-text' && tab?.id) {
    const tabId = tab.id;
    const text = info.selectionText;
    await handleReadTextAction(tabId, text);
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'read-text') {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      const tabId = tab.id;
      try {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => window.getSelection().toString(),
        });
        await handleReadTextAction(tabId, result);
      } catch (e) {
        console.error(`[BG] Failed to get selection from tab ${tabId}:`, e);
        try {
          await sendToTab(tabId, { action: 'error', message: 'Could not get selected text.' });
        } catch (sendError) {
          console.error(`[BG] Failed to send error to tab ${tabId}:`, sendError);
        }
      }
    }
  }
});

// FIXED: Migliorata gestione messaggi e errori
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Handle special messages that don't have tabId
  if (message.action === 'offscreenReady') {
    // Non fare nulla qui, è gestito da setupOffscreen
    return;
  }

  const tabId = sender.tab?.id || message.tabId;

  // Per messaggi che arrivano dal documento offscreen, potrebbero non avere tabId
  if (!tabId && (message.action === 'audioError' || message.action === 'audioEnded' ||
    message.action === 'audioTimeUpdate' || message.action === 'updateDuration')) {
    console.warn("[BG] Message from offscreen without tabId:", message.action);
  // Prova a usare il tabId dal messaggio se presente
  if (message.tabId) {
    // Continua con la logica normale
  } else {
    console.warn("[BG] Ignoring message without tabId:", message);
    return;
  }
    } else if (!tabId) {
      console.warn("[BG] Message received without tabId:", message);
      return;
    }

    const actualTabId = tabId || message.tabId;

    // Handle getState separately as it requires an immediate response
    if (message.action === 'getState') {
      (async () => {
        try {
          const data = await chrome.storage.session.get(actualTabId.toString());
          const state = data[actualTabId.toString()] || {};
          sendResponse(state);
        } catch (e) {
          console.error('[BG] Error getting state:', e);
          sendResponse({});
        }
      })();
      return true; // Indicate asynchronous response
    }

    // All other messages are handled asynchronously without direct response to sender
    (async () => {
      try {
        const data = await chrome.storage.session.get(actualTabId.toString());
        const state = data[actualTabId.toString()];

        if (!state && message.action !== 'offscreenReady' && message.action !== 'ping') {
          console.warn(`[BG] State not found for tab ${actualTabId} for action ${message.action}. Ignoring.`);
          return;
        }

        switch (message.action) {
          case 'play':
          case 'pause':
            if (state) {
              state.playing = message.action === 'play';
              await chrome.storage.session.set({ [actualTabId.toString()]: state });
            }

            try {
              await sendToOffscreen({
                target: 'offscreen',
                action: message.action === 'play' ? 'resumeAudio' : 'pauseAudio'
              });
            } catch (e) {
              console.error('[BG] Failed to send play/pause to offscreen:', e);
            }

            if (state) {
              try {
                await sendToTab(actualTabId, { action: 'updateState', state });
              } catch (e) {
                console.error(`[BG] Failed to update tab ${actualTabId} state:`, e);
              }
            }
            break;

          case 'skip':
            try {
              await sendToOffscreen({
                target: 'offscreen',
                action: 'seekAudio',
                time: message.value
              });
            } catch (e) {
              console.error('[BG] Failed to send skip to offscreen:', e);
            }
            break;

          case 'speed':
            if (state) {
              state.speed = message.value;
              await chrome.storage.session.set({ [actualTabId.toString()]: state });
            }

            try {
              await sendToOffscreen({
                target: 'offscreen',
                action: 'setSpeed',
                value: message.value
              });
            } catch (e) {
              console.error('[BG] Failed to send speed to offscreen:', e);
            }

            if (state) {
              try {
                await sendToTab(actualTabId, { action: 'updateState', state });
              } catch (e) {
                console.error(`[BG] Failed to update tab ${actualTabId} state:`, e);
              }
            }
            break;

          case 'audioEnded':
            // Rimuovi il tab dall'insieme degli audio attivi
            activeAudioTabs.delete(actualTabId);
            if (state) {
              state.playing = false;
              state.time = 0;
              await chrome.storage.session.set({ [actualTabId.toString()]: state });
              try {
                await sendToTab(actualTabId, { action: 'updateState', state });
              } catch (e) {
                console.error(`[BG] Failed to update tab ${actualTabId} state:`, e);
              }
            }
            break;

          case 'audioTimeUpdate':
            if (state) {
              state.time = message.currentTime;
              try {
                await sendToTab(actualTabId, { action: 'timeUpdate', time: message.currentTime });
              } catch (e) {
                console.error(`[BG] Failed to send time update to tab ${actualTabId}:`, e);
              }
            }
            break;

          case 'updateDuration':
            if (state) {
              state.duration = message.duration;
              await chrome.storage.session.set({ [actualTabId.toString()]: state });
              try {
                await sendToTab(actualTabId, { action: 'updateDuration', duration: message.duration });
              } catch (e) {
                console.error(`[BG] Failed to send duration update to tab ${actualTabId}:`, e);
              }
            }
            break;

          case 'audioError':
            try {
              await sendToTab(actualTabId, { action: 'error', message: message.error });
            } catch (e) {
              console.error(`[BG] Failed to send error to tab ${actualTabId}:`, e);
            }
            break;

          case 'ping':
            // Handled by ensureTabReady, no further action needed here
            break;

          case 'stopAudio':
            // Rimuovi il tab dall'insieme degli audio attivi
            activeAudioTabs.delete(actualTabId);
            // Gestisci stop audio dal content script
            try {
              await sendToOffscreen({
                target: 'offscreen',
                action: 'stopAudio',
                tabId: actualTabId
              });
            } catch (e) {
              console.error('[BG] Failed to send stop to offscreen:', e);
            }
            break;

          default:
            console.warn(`[BG] Unknown message action received: ${message.action}`);
        }
      } catch (e) {
        console.error('[BG] Error handling message:', e);
      }
    })();
    // No return true here, as sendResponse is only for getState
});

// FIXED: Gestione migliorata della chiusura tab
chrome.tabs.onRemoved.addListener(async (tabId) => {
  console.log(`[BG] Tab ${tabId} removed. Cleaning up.`);
  chrome.storage.session.remove(tabId.toString());

  // Invia messaggio di stop solo se il tab aveva audio attivo
  if (activeAudioTabs.has(tabId)) {
    activeAudioTabs.delete(tabId);
    try {
      await sendToOffscreen({
        target: 'offscreen',
        action: 'stopAudio',
        tabId: tabId
      });
    } catch (e) {
      console.warn(`[BG] Failed to send stop audio to offscreen for removed tab ${tabId}:`, e);
    }
  }
});

// FIXED: Gestione migliorata dell'aggiornamento tab
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading') {
    console.log(`[BG] Tab ${tabId} is loading. Stopping audio and cleaning up state.`);
    chrome.storage.session.remove(tabId.toString());

    // Invia messaggio di stop solo se il tab aveva audio attivo
    if (activeAudioTabs.has(tabId)) {
      activeAudioTabs.delete(tabId);
      try {
        await sendToOffscreen({
          target: 'offscreen',
          action: 'stopAudio',
          tabId: tabId
        });
      } catch (e) {
        console.warn(`[BG] Failed to send stop audio to offscreen for loading tab ${tabId}:`, e);
      }
    }
  }
});

chrome.alarms.create('keepAlive', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => {});
