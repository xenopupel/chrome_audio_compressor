// Presets now use margin (dB above floor) instead of absolute threshold
const PRESETS = {
  soft:       { margin: 12, ratio: 2, attack: 80,  release: 500, makeup: 2, knee: 6 },
  medium:     { margin: 8,  ratio: 3, attack: 50,  release: 300, makeup: 4, knee: 6 },
  aggressive: { margin: 4,  ratio: 6, attack: 20,  release: 150, makeup: 8, knee: 6 },
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
const adaptiveToggle  = document.getElementById('adaptive-toggle');
const thresholdInput  = document.getElementById('threshold');

const advancedInputs = {
  threshold: thresholdInput,
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
  enabled:   false,
  intensity: 50,
  adaptive:  true,
  margin:    8,
  threshold: -18,
  ratio:     3,
  attack:    50,
  release:   300,
  makeup:    4,
  knee:      6,
};

let advancedOpen  = false;
let latestFloorDb = null;

// ─── Display helpers ─────────────────────────────────────────────────────────

function updateThresholdDisplay() {
  if (state.adaptive) {
    const effective = latestFloorDb != null
      ? Math.round(latestFloorDb + state.margin)
      : '?';
    advancedLabels.threshold.textContent = `Auto: ${effective} dB`;
    thresholdInput.disabled = true;
    thresholdInput.style.opacity = '0.35';
  } else {
    advancedLabels.threshold.textContent =
      `${parseFloat(thresholdInput.value).toFixed(1)} dB`;
    thresholdInput.disabled = false;
    thresholdInput.style.opacity = '';
  }
}

function updateAdvancedLabels() {
  updateThresholdDisplay();
  advancedLabels.ratio.textContent   = `${parseFloat(advancedInputs.ratio.value).toFixed(1)} : 1`;
  advancedLabels.attack.textContent  = `${advancedInputs.attack.value} ms`;
  advancedLabels.release.textContent = `${advancedInputs.release.value} ms`;
  advancedLabels.makeup.textContent  = `+${parseFloat(advancedInputs.makeup.value).toFixed(1)} dB`;
}

function syncAdvancedInputs(params) {
  if (!state.adaptive && params.threshold != null) {
    advancedInputs.threshold.value = params.threshold;
  }
  advancedInputs.ratio.value   = params.ratio;
  advancedInputs.attack.value  = params.attack;
  advancedInputs.release.value = params.release;
  advancedInputs.makeup.value  = params.makeup;
  updateAdvancedLabels();
}

function buildPayload() {
  return {
    enabled:   state.enabled,
    adaptive:  state.adaptive,
    margin:    state.margin,
    threshold: parseFloat(thresholdInput.value), // used only when adaptive=false
    ratio:     parseFloat(advancedInputs.ratio.value),
    attack:    parseInt(advancedInputs.attack.value, 10),
    release:   parseInt(advancedInputs.release.value, 10),
    makeup:    parseFloat(advancedInputs.makeup.value),
    knee:      state.knee,
  };
}

// ─── Broadcast ───────────────────────────────────────────────────────────────

async function broadcast() {
  const payload = buildPayload();
  await chrome.storage.local.set({
    compressorState:     payload,
    compressorIntensity: state.intensity,
  });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  chrome.tabs.sendMessage(tab.id, { type: 'COMPRESSOR_UPDATE', payload }, (response) => {
    if (chrome.runtime.lastError) return;
    if (response?.floorDb != null) {
      latestFloorDb = response.floorDb;
      updateThresholdDisplay();
    }
    if (response?.count != null) updateStatus(response.count, state.enabled);
  });
}

// ─── Status bar ──────────────────────────────────────────────────────────────

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

// ─── Event handlers ──────────────────────────────────────────────────────────

enableToggle.addEventListener('change', () => {
  state.enabled = enableToggle.checked;
  setControlsEnabled(state.enabled);
  broadcast();
});

intensitySlider.addEventListener('input', () => {
  state.intensity = parseInt(intensitySlider.value, 10);
  intensityLbl.textContent = intensityLabel(state.intensity);
  const params = intensityToParams(state.intensity);
  state.margin = params.margin;
  if (!advancedOpen) {
    state = { ...state, ...params };
    syncAdvancedInputs(params);
  } else {
    updateThresholdDisplay();
  }
  broadcast();
});

adaptiveToggle.addEventListener('change', () => {
  state.adaptive = adaptiveToggle.checked;
  updateThresholdDisplay();
  broadcast();
});

for (const [key, input] of Object.entries(advancedInputs)) {
  input.addEventListener('input', () => {
    if (key === 'threshold') {
      // Manual edit only applies when adaptive is off
      if (state.adaptive) return;
    }
    advancedOpen = true;
    updateAdvancedLabels();
    broadcast();
  });
}

document.getElementById('advanced').addEventListener('toggle', (e) => {
  if (e.target.open) advancedOpen = true;
});

// ─── Init ────────────────────────────────────────────────────────────────────

async function init() {
  const stored = await chrome.storage.local.get(['compressorState', 'compressorIntensity']);
  const s         = stored.compressorState;
  const intensity = stored.compressorIntensity ?? 50;

  if (s) {
    state.enabled   = s.enabled   ?? false;
    state.knee      = s.knee      ?? 6;
    state.adaptive  = s.adaptive  ?? true;
    state.margin    = s.margin    ?? 8;
    state.intensity = intensity;

    enableToggle.checked   = state.enabled;
    adaptiveToggle.checked = state.adaptive;
    intensitySlider.value  = intensity;
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

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    chrome.tabs.sendMessage(tab.id, { type: 'GET_COUNT' }, (response) => {
      if (chrome.runtime.lastError) {
        updateStatus(0, state.enabled);
        return;
      }
      if (response?.floorDb != null) {
        latestFloorDb = response.floorDb;
        updateThresholdDisplay();
      }
      updateStatus(response?.count ?? 0, state.enabled);
    });
  }
}

// ─── Debug panel ─────────────────────────────────────────────────────────────

const debugBtn   = document.getElementById('debug-btn');
const debugPanel = document.getElementById('debug-panel');

const ICONS = { ok: '✓', cors: '⚠', err: '✗', found: '●' };

function renderDebug(entries) {
  if (!entries.length) {
    debugPanel.innerHTML = '<span style="color:#555">Нет событий. Перезагрузи страницу и попробуй снова.</span>';
    return;
  }

  // Group by frame
  const frames = {};
  for (const e of entries) {
    const key = `${e.isIframe ? 'iframe' : 'main'}: ${e.frameUrl}`;
    if (!frames[key]) frames[key] = [];
    frames[key].push(e);
  }

  debugPanel.innerHTML = Object.entries(frames).map(([frameLabel, evts]) => `
    <div class="dbg-frame">${frameLabel}</div>
    ${evts.map(e => `
      <div class="dbg-entry dbg-${e.type}">
        <span class="dbg-icon">${ICONS[e.type] ?? '?'}</span>
        <span class="dbg-msg">${e.msg}</span>
      </div>`).join('')}
  `).join('');
}

debugBtn.addEventListener('click', async () => {
  const isOpen = !debugPanel.classList.contains('hidden');
  if (isOpen) {
    debugPanel.classList.add('hidden');
    debugBtn.textContent = 'Debug';
    return;
  }

  debugPanel.classList.remove('hidden');
  debugBtn.textContent = 'Закрыть';
  debugPanel.innerHTML = '<span style="color:#555">Собираю...</span>';

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    renderDebug([]);
    return;
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => window.__cinemaDebug ?? [],
    });
    const all = results.flatMap(r => r.result ?? []);
    renderDebug(all);
  } catch (e) {
    debugPanel.innerHTML = `<span style="color:#f87171">Ошибка: ${e.message}</span>`;
  }
});

// React to hookElement completions that happen after the popup was already open
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.hookedCount != null) {
    updateStatus(changes.hookedCount.newValue, state.enabled);
  }
});

init();
