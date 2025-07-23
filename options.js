document.getElementById('save').addEventListener('click', () => {
  const apiKey = document.getElementById('apiKey').value;
  chrome.storage.local.set({ apiKey: apiKey }, () => {
    const status = document.getElementById('status');
    status.textContent = 'Options saved.';
    setTimeout(() => {
      status.textContent = '';
    }, 1500);
  });
});

// Carica la chiave salvata quando la pagina si apre
document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.local.get('apiKey', (data) => {
    if (data.apiKey) {
      document.getElementById('apiKey').value = data.apiKey;
    }
  });
});