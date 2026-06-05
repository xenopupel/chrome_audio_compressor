let sharedCtx = null;
let workletLoaded = false;
const processedElements = new Map();

// Debug log — collected by popup via chrome.scripting.executeScript
window.__cinemaDebug = [];
function dbg(type, msg) {
  const isIframe = window !== top;
  const frameUrl = location.href.replace(/^https?:\/\//, '').slice(0, 60);
  window.__cinemaDebug.unshift({ type, msg, isIframe, frameUrl });
  if (window.__cinemaDebug.length > 30) window.__cinemaDebug.pop();
}

const DEFAULT_STATE = {
  enabled: false,
  threshold: -18,
  ratio: 3,
  attack: 50,
  release: 300,
  makeup: 4,
  knee: 6,
  margin: 8,
  adaptive: true,
};

let currentState = { ...DEFAULT_STATE };
let latestFloorDb = null;

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
  processedElements.set(el, null);

  const elDesc = `${el.tagName.toLowerCase()} src="${(el.src || el.currentSrc || '').slice(0, 80)}"`;
  dbg('found', elDesc);

  try {
    await ensureContext();

    const sourceNode = sharedCtx.createMediaElementSource(el);
    const compressorNode = new AudioWorkletNode(sharedCtx, 'cinema-compressor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      parameterData: {
        threshold: currentState.threshold ?? -18,
        ratio:     currentState.ratio     ?? 3,
        attack:    (currentState.attack   ?? 50)  / 1000,
        release:   (currentState.release  ?? 300) / 1000,
        knee:      currentState.knee      ?? 6,
        bypass:    currentState.enabled   ? 0 : 1,
        margin:    currentState.margin    ?? 8,
        adaptive:  currentState.adaptive  ? 1 : 0,
      },
    });

    // Receive floor updates from worklet, relay latest value to popup
    compressorNode.port.onmessage = (e) => {
      if (e.data.type === 'floor') latestFloorDb = e.data.floorDb;
    };

    const makeupGainNode = sharedCtx.createGain();
    makeupGainNode.gain.value = currentState.enabled
      ? Math.pow(10, currentState.makeup / 20)
      : 1.0;

    sourceNode.connect(compressorNode);
    compressorNode.connect(makeupGainNode);
    makeupGainNode.connect(sharedCtx.destination);

    processedElements.set(el, { sourceNode, compressorNode, makeupGainNode });
    dbg('ok', `hooked ✓`);
    notifyPopup();
  } catch (err) {
    processedElements.delete(el);
    if (err.name === 'SecurityError') {
      dbg('cors', `SecurityError — CDN без CORS-заголовков. Нужен нативный хелпер.`);
      console.debug('[CinemaCompressor] SecurityError:', el.src);
    } else {
      dbg('err', `${err.name}: ${err.message}`);
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
    p.get('margin').setTargetAtTime(state.margin, t, 0.01);
    p.get('adaptive').setTargetAtTime(state.adaptive ? 1 : 0, t, 0.01);

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

function resumeOnInteraction() {
  if (sharedCtx && sharedCtx.state === 'suspended') sharedCtx.resume();
}
document.addEventListener('click', resumeOnInteraction, { passive: true });
document.addEventListener('keydown', resumeOnInteraction, { passive: true });

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

chrome.runtime.sendMessage({ type: 'GET_STATE' }, (response) => {
  if (chrome.runtime.lastError) { /* service worker not ready yet, use defaults */ }
  if (response?.payload) currentState = response.payload;
  scanAndHook();
});
scanAndHook();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'COMPRESSOR_UPDATE') {
    applyState(message.payload);
    sendResponse({ ok: true, count: countHooked(), floorDb: latestFloorDb });
  } else if (message.type === 'GET_COUNT') {
    sendResponse({ count: countHooked(), floorDb: latestFloorDb });
  }
});
