const DEFAULT_STATE = {
  enabled:   false,
  threshold: -18,
  ratio:     3,
  attack:    50,
  release:   300,
  makeup:    4,
  knee:      6,
  margin:    8,
  adaptive:  true,
};

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') {
    chrome.storage.local.set({ compressorState: DEFAULT_STATE });
  } else if (reason === 'update') {
    // Fill in any new fields that old stored state is missing
    chrome.storage.local.get('compressorState').then(({ compressorState }) => {
      if (compressorState) {
        chrome.storage.local.set({
          compressorState: { ...DEFAULT_STATE, ...compressorState },
        });
      }
    });
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
