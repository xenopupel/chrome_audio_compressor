const PRESETS = {
  soft:       { threshold: -24, ratio: 2,   attack: 80,  release: 500, makeup: 2, knee: 6 },
  medium:     { threshold: -18, ratio: 3,   attack: 50,  release: 300, makeup: 4, knee: 6 },
  aggressive: { threshold: -12, ratio: 6,   attack: 20,  release: 150, makeup: 8, knee: 6 },
};

function lerp(a, b, t) {
  const out = {};
  for (const k of Object.keys(a)) out[k] = a[k] + (b[k] - a[k]) * t;
  return out;
}

function intensityToParams(value) {
  if (value <= 33) return lerp(PRESETS.soft, PRESETS.medium, value / 33);
  if (value <= 66) return lerp(PRESETS.medium, PRESETS.aggressive, (value - 33) / 33);
  return lerp(PRESETS.aggressive, PRESETS.aggressive, (value - 66) / 34);
}

function intensityLabel(value) {
  if (value < 20) return 'Very Soft';
  if (value < 40) return 'Soft';
  if (value < 60) return 'Medium';
  if (value < 80) return 'Strong';
  return 'Aggressive';
}

// DOM refs
const enableToggle    = document.getElementById('enable-toggle');
const intensitySlider = document.getElementById('intensity-slider');
const intensityLbl    = document.getElementById('intensity-label');
const statusBar       = document.getElementById('status-bar');
const controlsSection = document.getElementById('controls-section');

const advancedInputs = {
  threshold: document.getElementById('threshold'),
  ratio:     document.getElementById('ratio'),
  attack:    document.getElementById('attack'),
  release:   document.getElementById('release'),
  makeup:    document.getElementById('makeup'),
};
const advancedLabels = {
  threshold: document.getElementById('threshold-val'),
  ratio:     document.getElementById('ratio-val'),
  attack:    document.getElementById('attack-val'),
  release:   document.getElementById('release-val'),
  makeup:    document.getElementById('makeup-val'),
};

let state = {
  enabled: false,
  intensity: 50,
  threshold: -18,
  ratio: 3,
  attack: 50,
  release: 300,
  makeup: 4,
  knee: 6,
};

let advancedOpen = false; // tracks whether user manually edited advanced params

function updateAdvancedLabels() {
  advancedLabels.threshold.textContent = `${parseFloat(advancedInputs.threshold.value).toFixed(1)} dB`;
  advancedLabels.ratio.textContent     = `${parseFloat(advancedInputs.ratio.value).toFixed(1)} : 1`;
  advancedLabels.attack.textContent    = `${advancedInputs.attack.value} ms`;
  advancedLabels.release.textContent   = `${advancedInputs.release.value} ms`;
  advancedLabels.makeup.textContent    = `+${parseFloat(advancedInputs.makeup.value).toFixed(1)} dB`;
}

function syncAdvancedInputs(params) {
  advancedInputs.threshold.value = params.threshold;
  advancedInputs.ratio.value     = params.ratio;
  advancedInputs.attack.value    = params.attack;
  advancedInputs.release.value   = params.release;
  advancedInputs.makeup.value    = params.makeup;
  updateAdvancedLabels();
}

function buildPayload() {
  return {
    enabled:   state.enabled,
    threshold: parseFloat(advancedInputs.threshold.value),
    ratio:     parseFloat(advancedInputs.ratio.value),
    attack:    parseInt(advancedInputs.attack.value, 10),
    release:   parseInt(advancedInputs.release.value, 10),
    makeup:    parseFloat(advancedInputs.makeup.value),
    knee:      state.knee,
  };
}

async function broadcast() {
  const payload = buildPayload();
  await chrome.storage.local.set({ compressorState: payload, compressorIntensity: state.intensity });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  chrome.tabs.sendMessage(tab.id, { type: 'COMPRESSOR_UPDATE', payload }, (response) => {
    if (chrome.runtime.lastError) return; // tab has no content script (chrome:// etc.)
    if (response?.count != null) updateStatus(response.count, state.enabled);
  });
}

function updateStatus(count, enabled) {
  if (!enabled) {
    statusBar.textContent = 'Compression off';
    statusBar.className = 'status off';
  } else if (count === 0) {
    statusBar.textContent = 'No media detected';
    statusBar.className = 'status idle';
  } else {
    statusBar.textContent = `Active on ${count} element${count > 1 ? 's' : ''}`;
    statusBar.className = 'status active';
  }
}

function setControlsEnabled(enabled) {
  controlsSection.classList.toggle('disabled', !enabled);
}

// --- Event handlers ---

enableToggle.addEventListener('change', () => {
  state.enabled = enableToggle.checked;
  setControlsEnabled(state.enabled);
  broadcast();
});

intensitySlider.addEventListener('input', () => {
  state.intensity = parseInt(intensitySlider.value, 10);
  intensityLbl.textContent = intensityLabel(state.intensity);
  if (!advancedOpen) {
    const params = intensityToParams(state.intensity);
    state = { ...state, ...params };
    syncAdvancedInputs(params);
  }
  broadcast();
});

for (const [key, input] of Object.entries(advancedInputs)) {
  input.addEventListener('input', () => {
    advancedOpen = true;
    updateAdvancedLabels();
    broadcast();
  });
}

document.getElementById('advanced').addEventListener('toggle', (e) => {
  if (e.target.open) advancedOpen = true;
});

// --- Init ---

async function init() {
  const stored = await chrome.storage.local.get(['compressorState', 'compressorIntensity']);
  const s = stored.compressorState;
  const intensity = stored.compressorIntensity ?? 50;

  if (s) {
    state.enabled   = s.enabled ?? false;
    state.knee      = s.knee ?? 6;
    state.intensity = intensity;

    enableToggle.checked = state.enabled;
    intensitySlider.value = intensity;
    intensityLbl.textContent = intensityLabel(intensity);

    syncAdvancedInputs({
      threshold: s.threshold ?? -18,
      ratio:     s.ratio     ?? 3,
      attack:    s.attack    ?? 50,
      release:   s.release   ?? 300,
      makeup:    s.makeup    ?? 4,
    });
  }

  setControlsEnabled(state.enabled);

  // Query current element count from content script
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: 'GET_COUNT' }, (response) => {
      if (chrome.runtime.lastError) {
        updateStatus(0, state.enabled);
        return;
      }
      updateStatus(response?.count ?? 0, state.enabled);
    });
  }
}

init();
