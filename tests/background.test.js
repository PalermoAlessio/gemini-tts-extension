// Mock browser environment
global.atob = (b64) => Buffer.from(b64, 'base64').toString('binary');
global.Blob = jest.fn((parts, options) => ({ 
  parts, 
  options, 
  size: parts.reduce((acc, p) => acc + p.length, 0) 
}));
global.URL = { 
  createObjectURL: jest.fn(blob => `blob:${Math.random()}`),
  revokeObjectURL: jest.fn()
};


// Comprehensive mock for chrome API
global.chrome = {
  runtime: {
    getURL: jest.fn(path => `chrome-extension://mock-id/${path}`),
    sendMessage: jest.fn((message, callback) => {
      // Simula il comportamento reale: ritorna una Promise
      const promise = callback ? 
        Promise.resolve().then(() => callback()) : 
        Promise.resolve();
      
      // Aggiungi il metodo catch alla Promise per supportare sendMessageSafely
      promise.catch = jest.fn((handler) => {
        // Non fare nulla di default (simula successo)
        return promise;
      });
      
      return promise;
    }),
    onInstalled: { 
      addListener: jest.fn() 
    },
    onMessage: { 
      addListener: jest.fn() 
    },
    getContexts: jest.fn().mockResolvedValue([]),
    lastError: null
  },
  scripting: {
    executeScript: jest.fn().mockResolvedValue([{ result: 'Selected sample text' }])
  },
  contextMenus: {
    create: jest.fn(),
    onClicked: { 
      addListener: jest.fn() 
    }
  },
  commands: {
    onCommand: { 
      addListener: jest.fn() 
    }
  },
  sidePanel: {
    open: jest.fn().mockResolvedValue(undefined)
  },
  alarms: {
    create: jest.fn(),
    onAlarm: { 
      addListener: jest.fn() 
    }
  },
  offscreen: {
    createDocument: jest.fn().mockResolvedValue(undefined),
    closeDocument: jest.fn().mockResolvedValue(undefined),
    Reason: {
      AUDIO_PLAYBACK: 'AUDIO_PLAYBACK'
    }
  },
  tabs: {
    query: jest.fn((query, callback) => {
      if (callback) callback([{ id: 123 }]);
    })
  }
};

// Mock fetch
global.fetch = jest.fn();

// Pulisci i moduli caricati prima di ogni test
beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  
  // Reset fetch mock
  fetch.mockReset();
  
  
  
  // Reset sendMessage mock to better reflect the real API
  chrome.runtime.sendMessage.mockImplementation((message, callback) => {
    if (message.target === 'offscreen') {
      // Simulate offscreen document receiving the message
      return Promise.resolve();
    }
    // The real API returns undefined if a callback is provided.
    if (callback) {
      // Simulate async callback execution
      Promise.resolve().then(() => callback());
      return; // No promise returned
    }
    // If no callback, return a resolved promise.
    // Tests that expect rejection will provide their own mock.
    return Promise.resolve();
  });
});

describe('Background Script - Manifest V3 Service Worker', () => {
  const mockConfig = {
    apiKey: 'test-key',
    voice: 'TestVoice',
    stylePrompt: 'Test prompt:',
  };

  // Helper per simulare risposte fetch
  const setupFetchMocks = (configResponse = mockConfig, apiResponse = null) => {
    fetch.mockImplementation((url) => {
      if (url.includes('config.json')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(configResponse),
        });
      } else if (url.includes('generativelanguage.googleapis.com') && apiResponse) {
        return Promise.resolve(apiResponse);
      }
      return Promise.reject(new Error('Unknown URL'));
    });
  };

  test('Service worker registra tutti i listener all\'avvio', () => {
    require('../background.js');
    
    expect(chrome.runtime.onInstalled.addListener).toHaveBeenCalled();
    expect(chrome.contextMenus.onClicked.addListener).toHaveBeenCalled();
    expect(chrome.commands.onCommand.addListener).toHaveBeenCalled();
    expect(chrome.runtime.onMessage.addListener).toHaveBeenCalled();
    expect(chrome.alarms.create).toHaveBeenCalledWith('keepAlive', { periodInMinutes: 1 });
    expect(chrome.alarms.onAlarm.addListener).toHaveBeenCalled();
  });

  test('onInstalled crea il menu contestuale', () => {
    require('../background.js');
    
    // Ottieni il callback registrato
    const onInstalledCallback = chrome.runtime.onInstalled.addListener.mock.calls[0][0];
    
    // Simula l'evento
    onInstalledCallback({ reason: 'install' });
    
    expect(chrome.contextMenus.create).toHaveBeenCalledWith({
      id: 'read-text',
      title: 'Leggi testo',
      contexts: ['selection']
    });
  });

  test('Menu contestuale genera TTS e apre side panel', async () => {
    setupFetchMocks(mockConfig, {
      ok: true,
      json: () => Promise.resolve({
        candidates: [{ 
          content: { 
            parts: [{ 
              inlineData: { 
                data: btoa('mock-audio-data')
              } 
            }] 
          } 
        }],
      }),
    });
    
    require('../background.js');
    
    // Ottieni il callback del menu
    const onClickedCallback = chrome.contextMenus.onClicked.addListener.mock.calls[0][0];
    
    // Simula il click
    await onClickedCallback(
      { menuItemId: 'read-text' },
      { id: 123 }
    );
    
    // Aspetta che tutte le promesse si risolvano
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Verifica le chiamate
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 123 },
      func: expect.any(Function),
    });
    
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('generativelanguage.googleapis.com'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-goog-api-key': 'test-key'
        })
      })
    );
    
    expect(chrome.sidePanel.open).toHaveBeenCalledWith({ tabId: 123 });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      target: 'offscreen',
      action: 'playAudio',
      audioBase64: btoa('mock-audio-data'),
      speed: 1.0
    });
  });

  test('Gestisce caso di nessun testo selezionato', async () => {
    setupFetchMocks();
    chrome.scripting.executeScript.mockResolvedValueOnce([{ result: '' }]);
    
    require('../background.js');
    
    const onClickedCallback = chrome.contextMenus.onClicked.addListener.mock.calls[0][0];
    
    await onClickedCallback(
      { menuItemId: 'read-text' },
      { id: 123 }
    );
    
    // Aspetta che tutte le promesse si risolvano
    await new Promise(resolve => setTimeout(resolve, 0));
    
    expect(chrome.sidePanel.open).toHaveBeenCalledWith({ tabId: 123 });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'error',
      message: 'No text selected',
    });
    // No TTS generation or offscreen message should occur
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining('generativelanguage.googleapis.com'), expect.any(Object));
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(expect.objectContaining({ target: 'offscreen' }));
  });

  test('Gestisce errori API', async () => {
    setupFetchMocks(mockConfig, {
      ok: false,
      statusText: 'Forbidden'
    });
    
    require('../background.js');
    
    const onClickedCallback = chrome.contextMenus.onClicked.addListener.mock.calls[0][0];
    
    await onClickedCallback(
      { menuItemId: 'read-text' },
      { id: 123 }
    );
    
    await new Promise(resolve => setTimeout(resolve, 100));
    
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'error',
      message: 'API error: Forbidden'
    });
  });

  test('Gestisce risposte API senza audio', async () => {
    setupFetchMocks(mockConfig, {
      ok: true,
      json: () => Promise.resolve({ candidates: [] })
    });
    
    require('../background.js');
    
    const onClickedCallback = chrome.contextMenus.onClicked.addListener.mock.calls[0][0];
    
    await onClickedCallback(
      { menuItemId: 'read-text' },
      { id: 123 }
    );
    
    await new Promise(resolve => setTimeout(resolve, 100));
    
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      action: 'error',
      message: 'No audio data in response'
    });
  });

  test('Comando tastiera attiva la lettura', async () => {
    setupFetchMocks(mockConfig, {
      ok: true,
      json: () => Promise.resolve({
        candidates: [{ 
          content: { 
            parts: [{ 
              inlineData: { 
                data: btoa('mock-audio-data')
              } 
            }] 
          } 
        }],
      }),
    });
    
    require('../background.js');
    
    const onCommandCallback = chrome.commands.onCommand.addListener.mock.calls[0][0];
    
    await onCommandCallback('read-text');
    
    // Aspetta che le promesse asincrone si risolvano
    await new Promise(resolve => setTimeout(resolve, 100));

    // Verifica che lo script sia stato eseguito e il side panel aperto
    expect(chrome.scripting.executeScript).toHaveBeenCalled();
    expect(chrome.sidePanel.open).toHaveBeenCalledWith({ tabId: 123 });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
      target: 'offscreen',
      action: 'playAudio',
      audioBase64: btoa('mock-audio-data'),
      speed: 1.0
    });
  });

  test('Messaggi runtime - getState ritorna lo stato corrente', () => {
    require('../background.js');
    
    const messageListener = chrome.runtime.onMessage.addListener.mock.calls[0][0];
    const sendResponse = jest.fn();
    
    const shouldRespond = messageListener(
      { action: 'getState' },
      {},
      sendResponse
    );
    
    expect(shouldRespond).toBe(true);
    expect(sendResponse).toHaveBeenCalledWith({
      text: '',
      playing: false,
      time: 0,
      speed: 1.0
    });
  });

  test('Messaggi runtime - controlli audio (play/pause/skip/speed)', async () => {
    require('../background.js');
    
    const messageListener = chrome.runtime.onMessage.addListener.mock.calls[0][0];

    // Test play
    messageListener({ action: 'play' }, {}, jest.fn());
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ target: 'offscreen', action: 'resumeAudio' });
    
    // Test pause
    messageListener({ action: 'pause' }, {}, jest.fn());
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ target: 'offscreen', action: 'pauseAudio' });
    
    // Test skip
    messageListener({ action: 'skip', value: 20 }, {}, jest.fn());
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ target: 'offscreen', action: 'seekAudio', time: 20 });
    
    // Test speed
    messageListener({ action: 'speed', value: 1.5 }, {}, jest.fn());
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ target: 'offscreen', action: 'setSpeed', value: 1.5 });
  });

  test('Alarm keepAlive non esegue log audio in riproduzione', () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    
    require('../background.js');
    
    const alarmListener = chrome.alarms.onAlarm.addListener.mock.calls[0][0];
    
    alarmListener({ name: 'keepAlive' });
    
    expect(consoleSpy).not.toHaveBeenCalled();
    
    consoleSpy.mockRestore();
  });

  test('sendMessageSafely gestisce errori di connessione', async () => {
    // Simula un errore di "Receiving end does not exist"
    const mockError = new Error('Could not establish connection. Receiving end does not exist.');
    chrome.runtime.sendMessage.mockImplementation(() => Promise.reject(mockError));
    
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    
    // Carica il modulo DOPO aver configurato il mock specifico
    const { sendMessageSafely } = require('../background.js');
    
    await sendMessageSafely({ action: 'test' });
    
    // Aspetta che la Promise si risolva/rejetta
    await new Promise(resolve => setTimeout(resolve, 0));
    
    // Non dovrebbe loggare errori per questo specifico messaggio
    expect(consoleSpy).not.toHaveBeenCalledWith('Error sending message:', mockError);
    
    // Simula un errore diverso
    const otherError = new Error('Another error');
    chrome.runtime.sendMessage.mockImplementation(() => Promise.reject(otherError));
    
    await sendMessageSafely({ action: 'test2' });
    await new Promise(resolve => setTimeout(resolve, 0));

    // Dovrebbe loggare altri tipi di errori
    expect(consoleSpy).toHaveBeenCalledWith('Error sending message:', otherError);
    
    consoleSpy.mockRestore();
  });
});