// offscreen.js - FIXED: Migliorata gestione tabId e errori

chrome.runtime.sendMessage({ action: 'offscreenReady' });

let currentAudio = null;
let currentTabId = null;

// --- FUNZIONI DI UTILITÀ PER AUDIO ---

function base64ToUint8(b64) {
  try {
    // Pulizia del base64: rimuovi caratteri non validi
    const cleanB64 = b64.replace(/[^A-Za-z0-9+/=]/g, '');

    // Verifica che sia multiplo di 4 (caratteristica base64)
    if (cleanB64.length % 4 !== 0) {
      console.warn(`[Offscreen] Base64 length ${cleanB64.length} not multiple of 4, padding...`);
      const padding = 4 - (cleanB64.length % 4);
      const paddedB64 = cleanB64 + '='.repeat(padding);
      console.log(`[Offscreen] Added ${padding} padding characters`);
    }

    const finalB64 = cleanB64.length % 4 === 0 ? cleanB64 : cleanB64 + '='.repeat(4 - (cleanB64.length % 4));

    console.log(`[Offscreen] Processing base64 string: length=${finalB64.length}, first 50 chars="${finalB64.substring(0, 50)}..."`);

    const binary = atob(finalB64);
    const len = binary.length;
    const bytes = new Uint8Array(len);

    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    console.log(`[Offscreen] Decoded ${len} bytes from base64`);
    return bytes;
  } catch (error) {
    console.error('[Offscreen] Error decoding base64:', error);
    console.error('[Offscreen] Base64 sample:', b64.substring(0, 100));
    throw new Error(`Invalid base64 audio data: ${error.message}`);
  }
}

// NUOVO: Funzione per tentare conversione formato sconosciuto
function attemptFormatConversion(bytes) {
  console.log('[Offscreen] Attempting format conversion for unknown format');

  // Controlla se potrebbe essere un container o wrapper
  const header = Array.from(bytes.slice(0, 32));
  console.log('[Offscreen] Full header (32 bytes):', header.map(b => b.toString(16).padStart(2, '0')).join(' '));

  // Cerca pattern di formati audio all'interno dei dati
  for (let offset = 0; offset < Math.min(bytes.length - 4, 1024); offset++) {
    // Cerca signature MP3 (FF Fx)
    if (bytes[offset] === 0xFF && (bytes[offset + 1] & 0xE0) === 0xE0) {
      console.log(`[Offscreen] Found potential MP3 data at offset ${offset}`);
      return bytes.slice(offset);
    }

    // Cerca signature WAV (RIFF)
    if (offset < bytes.length - 12 &&
      bytes[offset] === 0x52 && bytes[offset + 1] === 0x49 &&
      bytes[offset + 2] === 0x46 && bytes[offset + 3] === 0x46) {
      console.log(`[Offscreen] Found potential WAV data at offset ${offset}`);
    return bytes.slice(offset);
      }

      // Cerca signature OGG (OggS)
      if (offset < bytes.length - 4 &&
        bytes[offset] === 0x4F && bytes[offset + 1] === 0x67 &&
        bytes[offset + 2] === 0x67 && bytes[offset + 3] === 0x53) {
        console.log(`[Offscreen] Found potential OGG data at offset ${offset}`);
      return bytes.slice(offset);
        }
  }

  // Se non trova niente, restituisce i dati originali
  console.log('[Offscreen] No recognizable audio format found in data');
  return bytes;
}

function guessMime(bytes) {
  if (bytes.length < 12) {
    console.warn('[Offscreen] Audio data too short for format detection');
    return 'audio/mpeg'; // Default fallback
  }

  // OGG (OggS)
  if (bytes[0] === 0x4F && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) {
    console.log('[Offscreen] Detected format: OGG');
    return 'audio/ogg';
  }

  // RIFF/WAVE (RIFF....WAVE)
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45) {
    console.log('[Offscreen] Detected format: WAV');
  return 'audio/wav';
    }

    // WebM
    if (bytes[0] === 0x1A && bytes[1] === 0x45 && bytes[2] === 0xDF && bytes[3] === 0xA3) {
      console.log('[Offscreen] Detected format: WebM');
      return 'audio/webm';
    }

    // MP4/AAC (ftyp)
    if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
      console.log('[Offscreen] Detected format: MP4/AAC');
      return 'audio/mp4';
    }

    // ID3 (MP3 con tag)
    if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
      console.log('[Offscreen] Detected format: MP3 (with ID3)');
      return 'audio/mpeg';
    }

    // Frame MP3 senza ID3 (FF FB / FF F3 / FF F2)
    if (bytes[0] === 0xFF && (bytes[1] & 0xE0) === 0xE0) {
      console.log('[Offscreen] Detected format: MP3 (raw)');
      return 'audio/mpeg';
    }

    // FLAC
    if (bytes[0] === 0x66 && bytes[1] === 0x4C && bytes[2] === 0x61 && bytes[3] === 0x43) {
      console.log('[Offscreen] Detected format: FLAC');
      return 'audio/flac';
    }

    console.warn('[Offscreen] Unknown audio format, trying multiple MIME types');
    return null; // Indica formato sconosciuto
}

function stopAndCleanupAudio() {
  if (currentAudio) {
    currentAudio.pause();
    if (currentAudio.src && currentAudio.src.startsWith('blob:')) {
      URL.revokeObjectURL(currentAudio.src);
    }
    currentAudio.removeEventListener('ended', handleAudioEnd);
    currentAudio.removeEventListener('timeupdate', handleTimeUpdate);
    currentAudio.removeEventListener('loadedmetadata', handleLoadedMetadata);
    currentAudio.removeEventListener('error', handleAudioError);
    currentAudio = null;
  }
  // NON resettare currentTabId qui - mantienilo per i messaggi di cleanup
}

async function playAudio(audioBase64, speed, tabId, apiMimeType = 'unknown') {
  stopAndCleanupAudio();
  currentTabId = tabId;

  try {
    console.log(`[Offscreen] Starting playback for tab ${tabId} with API MIME type: ${apiMimeType}`);

    // Validazione iniziale base64
    if (!audioBase64 || audioBase64.length === 0) {
      throw new Error('Empty audio data received');
    }

    const originalBytes = base64ToUint8(audioBase64);
    console.log(`[Offscreen] Original audio data: ${originalBytes.length} bytes`);

    if (originalBytes.length === 0) {
      throw new Error('Decoded audio data is empty');
    }

    // DEBUG: Magic bytes
    const magicBytesHex = Array.from(originalBytes.slice(0, 16))
    .map(b => b.toString(16).padStart(2, '0')).join(' ');
    console.log('[Offscreen] Magic bytes (first 16):', magicBytesHex);
    console.log('[Offscreen] API MIME type:', apiMimeType);

    // STRATEGIA SEMPLIFICATA: Se l'API dice PCM L16, usa direttamente il metodo semplice
    if (apiMimeType && apiMimeType.includes('L16') && apiMimeType.includes('pcm')) {
      console.log('[Offscreen] API indicates PCM L16, using direct simple PCM playback...');
      await tryRawAudioPlayback(originalBytes, speed);
      return;
    }

    // Se i magic bytes indicano PCM raw (pattern tipici), usa PCM diretto
    if (magicBytesHex.startsWith('ee ff') || magicBytesHex.startsWith('ff ff')) {
      console.log('[Offscreen] Magic bytes suggest raw PCM, using direct PCM playback...');
      await tryRawAudioPlayback(originalBytes, speed);
      return;
    }

    // Solo se non è chiaramente PCM, prova gli altri metodi
    const detectedMime = guessMime(originalBytes);
    console.log('[Offscreen] Detected MIME type:', detectedMime || 'unknown');

    if (detectedMime) {
      console.log(`[Offscreen] Trying standard playback with detected format: ${detectedMime}`);
      try {
        await tryPlayWithMimeTypes(originalBytes, [detectedMime], speed);
        return;
      } catch (error) {
        console.warn(`[Offscreen] Standard playback failed:`, error.message);
      }
    }

    // Fallback finale: prova PCM semplice
    console.log('[Offscreen] Fallback: trying simple PCM interpretation...');
    await tryRawAudioPlayback(originalBytes, speed);

  } catch (error) {
    console.error('[Offscreen] All audio playback attempts failed:', error);
    chrome.runtime.sendMessage({
      action: 'audioError',
      error: `Audio playback failed: ${error.message}`,
      tabId: currentTabId || tabId
    });
    stopAndCleanupAudio();
  }
}

// SEMPLIFICATO: Tentativo di riproduzione raw PCM - Versione Basic
async function tryRawAudioPlayback(bytes, speed) {
  try {
    console.log('[Offscreen] Simple PCM interpretation (L16 24kHz mono)...');

    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const sampleRate = 24000; // Dal MIME type dell'API
    const channels = 1; // Mono

    // SEMPLICE: Interpretazione diretta L16 senza filtri complessi
    const samples = new Float32Array(Math.floor(bytes.length / 2));

    for (let i = 0; i < samples.length; i++) {
      // L16 = Little-endian 16-bit PCM
      const low = bytes[i * 2];
      const high = bytes[i * 2 + 1];

      // Combina in signed 16-bit
      let sample16 = (high << 8) | low;

      // Converti a signed se necessario
      if (sample16 > 32767) {
        sample16 -= 65536;
      }

      // Normalizza semplicemente
      samples[i] = sample16 / 32768.0;
    }

    console.log(`[Offscreen] Processed ${samples.length} samples, duration: ${samples.length / sampleRate} seconds`);

    // Crea buffer audio diretto - NESSUN FILTRO
    const audioBuffer = audioContext.createBuffer(channels, samples.length, sampleRate);
    audioBuffer.getChannelData(0).set(samples);

    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.playbackRate.value = speed;
    source.connect(audioContext.destination); // Connessione diretta, no gain/filtri

    // Setup per compatibilità
    currentAudio = {
      play: () => {
        source.start(0);
        return Promise.resolve();
      },
      pause: () => source.stop(),
      currentTime: 0,
      duration: audioBuffer.duration,
      playbackRate: speed,
      paused: false,
      ended: false,
      addEventListener: (event, handler) => {
        if (event === 'ended') source.addEventListener('ended', handler);
        else if (event === 'loadedmetadata') setTimeout(handler, 0);
      },
      removeEventListener: () => {},
      src: 'simple-pcm://generated'
    };

    source.addEventListener('ended', () => {
      currentAudio.ended = true;
      handleAudioEnd();
    });

    // Simula timeupdate
    const startTime = audioContext.currentTime;
    const updateInterval = setInterval(() => {
      if (currentAudio && !currentAudio.ended) {
        const elapsed = audioContext.currentTime - startTime;
        currentAudio.currentTime = elapsed * speed;
        handleTimeUpdate();

        if (elapsed >= audioBuffer.duration) {
          clearInterval(updateInterval);
        }
      } else {
        clearInterval(updateInterval);
      }
    }, 100);

    handleLoadedMetadata();
    await currentAudio.play();
    console.log('[Offscreen] Simple PCM playback started');

  } catch (error) {
    console.error('[Offscreen] Simple PCM playback failed:', error);
    throw error;
  }
}

async function tryPlayWithMimeTypes(bytes, mimeTypes, speed) {
  let lastError = null;

  for (let i = 0; i < mimeTypes.length; i++) {
    const mimeType = mimeTypes[i];
    console.log(`[Offscreen] Attempting to play with MIME type: ${mimeType} (${i + 1}/${mimeTypes.length})`);

    try {
      const blob = new Blob([bytes], { type: mimeType });
      const audioUrl = URL.createObjectURL(blob);

      currentAudio = new Audio(audioUrl);
      currentAudio.playbackRate = speed;

      // Promise per aspettare il caricamento dei metadati o errore
      await new Promise((resolve, reject) => {
        let resolved = false;

        const cleanup = () => {
          if (!resolved) {
            resolved = true;
            currentAudio.removeEventListener('loadedmetadata', onLoaded);
            currentAudio.removeEventListener('error', onError);
            currentAudio.removeEventListener('canplay', onCanPlay);
          }
        };

        const onLoaded = () => {
          cleanup();
          resolve();
        };

        const onCanPlay = () => {
          cleanup();
          resolve();
        };

        const onError = (e) => {
          cleanup();
          const errorDetail = e.target?.error;
          let errorMsg = `Audio error with ${mimeType}`;
          if (errorDetail) {
            errorMsg += ` (Code: ${errorDetail.code}, Message: ${errorDetail.message || 'Unknown'})`;
          }
          reject(new Error(errorMsg));
        };

        currentAudio.addEventListener('loadedmetadata', onLoaded);
        currentAudio.addEventListener('canplay', onCanPlay);
        currentAudio.addEventListener('error', onError);

        // Timeout più lungo per formati complessi
        setTimeout(() => {
          if (!resolved) {
            cleanup();
            reject(new Error(`Timeout loading audio with ${mimeType} after 5 seconds`));
          }
        }, 5000);
      });

      // Se arriviamo qui, il formato funziona
      console.log(`[Offscreen] Successfully loaded audio with MIME type: ${mimeType}`);

      // Aggiungi i listener definitivi
      currentAudio.addEventListener('ended', handleAudioEnd);
      currentAudio.addEventListener('timeupdate', handleTimeUpdate);
      currentAudio.addEventListener('loadedmetadata', handleLoadedMetadata);
      currentAudio.addEventListener('error', handleAudioError);

      // Avvia la riproduzione
      await currentAudio.play();
      console.log('[Offscreen] Audio playback started successfully');
      return; // Successo!

    } catch (error) {
      console.warn(`[Offscreen] Failed to play with ${mimeType}:`, error.message);
      lastError = error;

      // Pulisci l'audio fallito
      if (currentAudio) {
        if (currentAudio.src && currentAudio.src.startsWith('blob:')) {
          URL.revokeObjectURL(currentAudio.src);
        }
        currentAudio = null;
      }
    }
  }

  // Se arriviamo qui, nessun formato ha funzionato - prova approccio alternativo
  console.warn('[Offscreen] Standard playback failed, trying Web Audio API approach');
  return await tryWebAudioAPIPlayback(bytes, speed);
}

// NUOVO: Approccio alternativo con Web Audio API
async function tryWebAudioAPIPlayback(bytes, speed) {
  try {
    console.log('[Offscreen] Trying Web Audio API for unsupported format');

    // Crea un AudioContext
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();

    // Prova a decodificare l'audio
    const audioBuffer = await audioContext.decodeAudioData(bytes.buffer.slice());

    console.log('[Offscreen] Successfully decoded audio with Web Audio API');

    // Crea un AudioBufferSourceNode
    const source = audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.playbackRate.value = speed;

    // Connetti alla destinazione
    source.connect(audioContext.destination);

    // Simula un oggetto Audio per compatibilità
    const duration = audioBuffer.duration;

    currentAudio = {
      play: () => {
        source.start(0);
        return Promise.resolve();
      },
      pause: () => {
        source.stop();
      },
      currentTime: 0,
      duration: duration,
      playbackRate: speed,
      paused: false,
      ended: false,
      addEventListener: (event, handler) => {
        if (event === 'ended') {
          source.addEventListener('ended', handler);
        } else if (event === 'loadedmetadata') {
          // Simula loadedmetadata chiamandolo subito
          setTimeout(handler, 0);
        }
      },
      removeEventListener: () => {},
      src: 'webaudio://generated'
    };

    // Simula gli eventi
    source.addEventListener('ended', () => {
      currentAudio.ended = true;
      handleAudioEnd();
    });

    // Simula timeupdate
    const startTime = audioContext.currentTime;
    const updateInterval = setInterval(() => {
      if (currentAudio && !currentAudio.ended) {
        const elapsed = audioContext.currentTime - startTime;
        currentAudio.currentTime = elapsed * speed;
        handleTimeUpdate();

        if (elapsed >= duration) {
          clearInterval(updateInterval);
        }
      } else {
        clearInterval(updateInterval);
      }
    }, 100);

    // Aggiungi i listener
    currentAudio.addEventListener('ended', handleAudioEnd);
    currentAudio.addEventListener('loadedmetadata', handleLoadedMetadata);

    // Notifica la durata
    handleLoadedMetadata();

    // Avvia la riproduzione
    await currentAudio.play();
    console.log('[Offscreen] Web Audio API playback started successfully');

  } catch (error) {
    console.error('[Offscreen] Web Audio API failed:', error);
    throw new Error(`All playback methods failed. Original error: ${error.message}`);
  }
}

// --- GESTORI DI EVENTI AUDIO ---

function handleAudioEnd() {
  console.log('[Offscreen] Audio ended');
  // FIXED: Includi sempre tabId
  chrome.runtime.sendMessage({
    action: 'audioEnded',
    tabId: currentTabId
  });
  // Reset currentTabId dopo la fine dell'audio
  currentTabId = null;
  stopAndCleanupAudio();
}

function handleTimeUpdate() {
  if (currentAudio && currentTabId) {
    chrome.runtime.sendMessage({
      action: 'audioTimeUpdate',
      currentTime: currentAudio.currentTime,
      tabId: currentTabId
    });
  }
}

function handleLoadedMetadata() {
  if (currentAudio && currentTabId) {
    console.log('[Offscreen] Audio duration:', currentAudio.duration);
    chrome.runtime.sendMessage({
      action: 'updateDuration',
      duration: currentAudio.duration,
      tabId: currentTabId
    });
  }
}

function handleAudioError(event) {
  console.error('[Offscreen] Audio playback error event:', event);
  let errorMessage = 'Playback error: Unknown error';
  if (event.target && event.target.error) {
    const mediaError = event.target.error;
    // Mappa i codici di errore comuni per messaggi più chiari
    switch (mediaError.code) {
      case mediaError.MEDIA_ERR_ABORTED:
        errorMessage = 'Playback aborted.';
        break;
      case mediaError.MEDIA_ERR_NETWORK:
        errorMessage = 'Network error during playback.';
        break;
      case mediaError.MEDIA_ERR_DECODE:
        errorMessage = `Audio decode error: ${mediaError.message || 'Corrupted or unsupported format.'}`;
        break;
      case mediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
        errorMessage = `Audio format not supported: ${mediaError.message || 'MIME type mismatch or invalid data.'}`;
        break;
      default:
        errorMessage = `Playback error: ${mediaError.message || 'Unknown error'} (Code: ${mediaError.code})`;
    }
    console.error(`[Offscreen] MediaError code: ${mediaError.code}, message: ${mediaError.message}`);
  }

  // FIXED: Includi sempre tabId
  chrome.runtime.sendMessage({
    action: 'audioError',
    error: errorMessage,
    tabId: currentTabId
  });
  stopAndCleanupAudio();
}

// --- LISTENER MESSAGGI ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.target !== 'offscreen') return;

  console.log('[Offscreen] Received message:', message.action, 'for tab:', message.tabId);

  switch (message.action) {
    case 'playAudio':
      if (message.tabId) {
        // Passa anche il mimeType se disponibile
        const mimeType = message.mimeType || 'unknown';
        console.log(`[Offscreen] Received audio with MIME type: ${mimeType}`);

        // Usa una IIFE async per gestire la funzione async
        (async () => {
          try {
            await playAudio(message.audioBase64, message.speed, message.tabId, mimeType);
          } catch (error) {
            console.error('[Offscreen] Error in playAudio:', error);
            chrome.runtime.sendMessage({
              action: 'audioError',
              error: error.message,
              tabId: message.tabId
            });
          }
        })();
      } else {
        console.error('[Offscreen] playAudio message missing tabId');
      }
      break;

    case 'stopAudio':
      // Se il messaggio specifica un tabId, fermati solo se corrisponde
      if (message.tabId) {
        if (message.tabId === currentTabId) {
          console.log(`[Offscreen] Stopping audio for tab ${message.tabId}`);
          stopAndCleanupAudio();
          currentTabId = null;
        } else {
          console.log(`[Offscreen] Ignoring stop for tab ${message.tabId}, current tab is ${currentTabId}`);
        }
      } else {
        // Se non c'è tabId, ferma qualsiasi audio in riproduzione
        console.log('[Offscreen] Stopping all audio');
        stopAndCleanupAudio();
        currentTabId = null;
      }
      break;

    case 'pauseAudio':
      if (currentAudio) {
        currentAudio.pause();
        console.log('[Offscreen] Audio paused');
      }
      break;

    case 'resumeAudio':
      if (currentAudio) {
        currentAudio.play().catch((error) => {
          console.error('[Offscreen] Error resuming audio:', error);
          handleAudioError({ target: { error } });
        });
        console.log('[Offscreen] Audio resumed');
      }
      break;

    case 'seekAudio':
      if (currentAudio && isFinite(message.time)) {
        currentAudio.currentTime = message.time;
        console.log(`[Offscreen] Audio seeked to ${message.time}s`);
      }
      break;

    case 'setSpeed':
      if (currentAudio && isFinite(message.value)) {
        currentAudio.playbackRate = message.value;
        console.log(`[Offscreen] Audio speed set to ${message.value}x`);
      }
      break;

    default:
      console.warn(`[Offscreen] Unknown action: ${message.action}`);
  }
});

// FIXED: Gestione migliore della chiusura della finestra/tab
window.addEventListener('beforeunload', () => {
  console.log('[Offscreen] Document unloading, cleaning up audio');
  stopAndCleanupAudio();
});

console.log('[Offscreen] Script loaded and ready');
