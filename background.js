const DEFAULT_STATE = {
  enabled: false,
  threshold: -18,
  ratio: 3,
  attack: 50,
  release: 300,
  makeup: 4,
  knee: 6,
};

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    chrome.storage.local.set({ compressorState: DEFAULT_STATE });
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'GET_STATE') {
    chrome.storage.local.get('compressorState').then(({ compressorState }) => {
      sendResponse({ payload: compressorState ?? DEFAULT_STATE });
    });
    return true; // keep channel open for async sendResponse
  }
});
