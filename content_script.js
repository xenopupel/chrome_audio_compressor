let sharedCtx = null;
let workletLoaded = false;
const processedElements = new Map();

const DEFAULT_STATE = {
  enabled: false,
  threshold: -18,
  ratio: 3,
  attack: 50,
  release: 300,
  makeup: 4,
  knee: 6,
};

let currentState = { ...DEFAULT_STATE };

async function ensureContext() {
  if (!sharedCtx) {
    sharedCtx = new AudioContext({ latencyHint: 'playback' });
  }
  if (sharedCtx.state === 'suspended') {
    await sharedCtx.resume();
  }
  if (!workletLoaded) {
    const url = chrome.runtime.getURL('worklet/compressor-processor.js');
    await sharedCtx.audioWorklet.addModule(url);
    workletLoaded = true;
  }
}

async function hookElement(el) {
  if (processedElements.has(el)) return;
  // Reserve the spot immediately to prevent concurrent hookElement calls on same el
  processedElements.set(el, null);

  try {
    await ensureContext();

    const sourceNode = sharedCtx.createMediaElementSource(el);
    const compressorNode = new AudioWorkletNode(sharedCtx, 'cinema-compressor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      parameterData: {
        threshold: currentState.threshold,
        ratio: currentState.ratio,
        attack: currentState.attack / 1000,
        release: currentState.release / 1000,
        knee: currentState.knee,
        bypass: currentState.enabled ? 0 : 1,
      },
    });
    const makeupGainNode = sharedCtx.createGain();
    makeupGainNode.gain.value = currentState.enabled
      ? Math.pow(10, currentState.makeup / 20)
      : 1.0;

    sourceNode.connect(compressorNode);
    compressorNode.connect(makeupGainNode);
    makeupGainNode.connect(sharedCtx.destination);

    processedElements.set(el, { sourceNode, compressorNode, makeupGainNode });
    notifyPopup();
  } catch (err) {
    processedElements.delete(el);
    if (err.name === 'SecurityError') {
      console.debug('[CinemaCompressor] Skipped cross-origin element:', el.src);
    } else {
      console.warn('[CinemaCompressor] hookElement error:', err);
    }
  }
}

function applyState(state) {
  currentState = state;
  for (const [, nodes] of processedElements) {
    if (!nodes) continue;
    const { compressorNode, makeupGainNode } = nodes;
    const p = compressorNode.parameters;
    const t = sharedCtx.currentTime;

    p.get('threshold').setTargetAtTime(state.threshold, t, 0.01);
    p.get('ratio').setTargetAtTime(state.ratio, t, 0.01);
    p.get('attack').setTargetAtTime(state.attack / 1000, t, 0.01);
    p.get('release').setTargetAtTime(state.release / 1000, t, 0.01);
    p.get('knee').setTargetAtTime(state.knee, t, 0.01);
    p.get('bypass').setTargetAtTime(state.enabled ? 0 : 1, t, 0.01);

    const makeupLin = Math.pow(10, state.makeup / 20);
    makeupGainNode.gain.setTargetAtTime(state.enabled ? makeupLin : 1.0, t, 0.05);
  }
}

function countHooked() {
  let n = 0;
  for (const [, nodes] of processedElements) if (nodes) n++;
  return n;
}

function notifyPopup() {
  chrome.runtime.sendMessage({ type: 'ELEMENT_COUNT', count: countHooked() }).catch(() => {});
}

// Resume AudioContext on first user interaction (browser autoplay policy)
function resumeOnInteraction() {
  if (sharedCtx && sharedCtx.state === 'suspended') sharedCtx.resume();
}
document.addEventListener('click', resumeOnInteraction, { passive: true });
document.addEventListener('keydown', resumeOnInteraction, { passive: true });

// Discover media elements
function scanAndHook() {
  document.querySelectorAll('video, audio').forEach(hookElement);
}

const observer = new MutationObserver((mutations) => {
  for (const m of mutations) {
    for (const node of m.addedNodes) {
      if (node.nodeType !== 1) continue;
      if (node.matches?.('video, audio')) hookElement(node);
      node.querySelectorAll?.('video, audio').forEach(hookElement);
    }
  }
});
observer.observe(document.documentElement, { childList: true, subtree: true });

// Load persisted state, then scan
// Always scan regardless of whether background responds (MV3 service worker may be terminated)
chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
  if (chrome.runtime.lastError) { /* service worker not ready yet, use defaults */ }
  if (response?.payload) currentState = response.payload;
  scanAndHook();
});
// Fallback: scan immediately so elements added before the response are caught
scanAndHook();

// Handle updates from popup
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'COMPRESSOR_UPDATE') {
    applyState(message.payload);
    sendResponse({ ok: true, count: countHooked() });
  } else if (message.type === 'GET_COUNT') {
    sendResponse({ count: countHooked() });
  }
});
