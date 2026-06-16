const TOKEN_KEY = 'jonGatewayToken';
const CONFIRM_TIMEOUT_KEY = 'jonGatewayConfirmTimeoutMs';
const PRESETS_KEY = 'jonGatewayPresets';
const DEFAULT_CONFIRM_TIMEOUT_MS = 2500;

const state = {
  token: localStorage.getItem(TOKEN_KEY) || '',
  confirmTimeoutMs: readConfirmTimeout(),
  schema: null,
  values: {},
  fpsHistory: [],
  lastFpsPaintMs: 0,
  lastFpsGraphSampleMs: 0,
  presets: readPresets(),
  assets: { backgrounds: [], pause: [] },
  pending: {},
  ws: null,
  wsReconnectTimer: null,
  wsConnected: false,
  rendered: false
};

const elements = {
  stages: document.querySelector('#stages'),
  message: document.querySelector('#message'),
  connectionStatus: document.querySelector('#connectionStatus'),
  fpsStatus: document.querySelector('#fpsStatus'),
  latencyStatus: document.querySelector('#latencyStatus'),
  versionStatus: document.querySelector('#versionStatus'),
  ipcStatus: document.querySelector('#ipcStatus'),
  presetList: document.querySelector('#presetList'),
  savePresetButton: document.querySelector('#savePresetButton'),
  importPresetsButton: document.querySelector('#importPresetsButton'),
  exportPresetsButton: document.querySelector('#exportPresetsButton'),
  importPresetsInput: document.querySelector('#importPresetsInput'),
  presetDialog: document.querySelector('#presetDialog'),
  presetNameInput: document.querySelector('#presetNameInput'),
  confirmSavePresetButton: document.querySelector('#confirmSavePresetButton'),
  settingsButton: document.querySelector('#settingsButton'),
  refreshButton: document.querySelector('#refreshButton'),
  settingsDialog: document.querySelector('#settingsDialog'),
  tokenInput: document.querySelector('#tokenInput'),
  showTokenInput: document.querySelector('#showTokenInput'),
  confirmTimeoutInput: document.querySelector('#confirmTimeoutInput'),
  saveTokenButton: document.querySelector('#saveTokenButton'),
  clearTokenButton: document.querySelector('#clearTokenButton')
};

const STAGES = [
  {
    title: 'INPUT',
    keys: ['camera.enabled']
  },
  {
    title: 'MASK',
    keys: ['runtime.noMask', 'segmentation.threshold', 'segmentation.smoothing', 'segmentation.morphology']
  },
  {
    title: 'BACKGROUND',
    keys: ['runtime.noOverlay', 'background.effect', 'background.blurStrength', 'background.image', 'background.overlayColor', 'background.loopIfVideo']
  },
  {
    title: 'PAUSE',
    keys: ['pause.enabled', 'pause.image', 'pause.loopIfVideo', 'pause.showStatusText', 'pause.textColor', 'pause.textSize', 'pause.font']
  }
];

const LABELS = {
  'camera.enabled': 'Camera',
  'runtime.noMask': 'Enable Mask',
  'segmentation.threshold': 'Threshold',
  'segmentation.smoothing': 'Smoothing',
  'segmentation.morphology': 'Morphology',
  'background.effect': 'Mode',
  'background.blurStrength': 'Blur Strength',
  'background.image': 'Background Asset',
  'background.loopIfVideo': 'Loop Background Video',
  'runtime.noOverlay': 'Enable Background',
  'background.overlayAlpha': 'Alpha',
  'background.overlayColor': 'Background Color',
  'pause.enabled': 'Pause Image',
  'pause.image': 'Pause Asset',
  'pause.loopIfVideo': 'Loop Pause Video',
  'pause.showStatusText': 'Status Text',
  'pause.textColor': 'Text Color',
  'pause.textSize': 'Text Size',
  'pause.textPosition': 'Text Position',
  'pause.font': 'Font'
};

const BOOLEAN_INVERTED = new Set(['runtime.noMask', 'runtime.noOverlay']);
const SELECT_ENUM_KEYS = new Set(['pause.font']);

function authHeaders(extra = {}) {
  return {
    ...extra,
    Authorization: `Bearer ${state.token}`
  };
}

async function apiFetch(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: authHeaders(options.headers || {})
  });
  const data = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }));
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

async function ipc(request) {
  const started = performance.now();
  const data = await apiFetch('/api/ipc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request)
  });
  elements.latencyStatus.textContent = `Latency ${Math.round(performance.now() - started)}ms`;
  elements.ipcStatus.textContent = request.key ? request.key : request.cmd;
  return data;
}

function showMessage(text, error = false) {
  elements.message.textContent = text;
  elements.message.classList.toggle('error', error);
  elements.message.classList.add('visible');
  clearTimeout(showMessage.timer);
  showMessage.timer = setTimeout(() => {
    elements.message.textContent = '';
    elements.message.classList.remove('visible', 'error');
  }, error ? 7000 : 3000);
}

function readConfirmTimeout() {
  const raw = localStorage.getItem(CONFIRM_TIMEOUT_KEY);
  if (raw === null || raw === '') return DEFAULT_CONFIRM_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isFinite(value)) return DEFAULT_CONFIRM_TIMEOUT_MS;
  return clamp(value, 500, 15000);
}

function setConnected(connected) {
  elements.connectionStatus.textContent = connected ? '● Connected' : '● Disconnected';
  elements.connectionStatus.classList.toggle('connected', connected);
}

async function loadSchema() {
  const result = await apiFetch('/api/schema');
  state.schema = result.config;
  updateVersion(result.config.gateway);
}

async function loadValues() {
  const result = await ipc({ cmd: 'list' });
  const changedKeys = applyState(result);
  updateBenchmark(state.values.benchmark);
  return changedKeys;
}

async function loadAssets() {
  const roots = Object.keys(state.schema?.files?.roots || {});
  const changedRoots = [];
  await Promise.all(roots.map(async (root) => {
    const data = await apiFetch(`/api/files/${encodeURIComponent(root)}`);
    const nextFiles = data.files || [];
    if (assetListSignature(state.assets[root]) !== assetListSignature(nextFiles)) changedRoots.push(root);
    state.assets[root] = nextFiles;
  }));
  return changedRoots;
}

function assetListSignature(files = []) {
  return JSON.stringify(files.map((file) => ({
    id: file.id,
    name: file.name,
    type: file.type,
    description: file.description,
    version: file.version
  })));
}

function flattenValues(source, prefix = '', out = {}) {
  if (!source || typeof source !== 'object') return out;
  if (!prefix && source.values && typeof source.values === 'object' && !Array.isArray(source.values)) {
    return flattenValues(source.values, '', out);
  }
  for (const [key, value] of Object.entries(source)) {
    if (key === 'ok' || key === 'key') continue;
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      flattenValues(value, nextKey, out);
    } else {
      out[nextKey] = value;
    }
  }
  return out;
}

function updateBenchmark(benchmark) {
  const fps = readFpsValue(benchmark);
  const label = elements.fpsStatus.querySelector('.fps-label');
  const polyline = elements.fpsStatus.querySelector('polyline');
  const polygon = elements.fpsStatus.querySelector('polygon');
  if (!Number.isFinite(fps)) {
    if (label) label.textContent = 'FPS --';
    if (polyline) polyline.setAttribute('points', sparklinePoints(state.fpsHistory));
    if (polygon) polygon.setAttribute('points', sparklineAreaPoints(state.fpsHistory));
    return;
  }

  const now = performance.now();
  if (state.fpsHistory.length > 0 && now - state.lastFpsPaintMs < 900) return;
  state.lastFpsPaintMs = now;
  if (label) label.textContent = `FPS ${fps.toFixed(1)}`;

  if (state.fpsHistory.length === 0 || now - state.lastFpsGraphSampleMs >= 2700) {
    state.lastFpsGraphSampleMs = now;
    state.fpsHistory.push(fps);
    if (state.fpsHistory.length > 32) state.fpsHistory.shift();
    if (polyline) polyline.setAttribute('points', sparklinePoints(state.fpsHistory));
    if (polygon) polygon.setAttribute('points', sparklineAreaPoints(state.fpsHistory));
  }
}

function readFpsValue(benchmark) {
  if (benchmark && typeof benchmark === 'object') {
    const fps = firstFiniteNumber(
      benchmark.fps,
      benchmark.framesPerSecond,
      benchmark.averageFps,
      benchmark.currentFps,
      benchmark.avgFps,
      benchmark.processingFps,
      benchmark.pipelineFps,
      benchmark.videoFps
    );
    if (Number.isFinite(fps)) return fps;
  }
  return firstFiniteNumber(
    state.values['benchmark.fps'],
    state.values['benchmark.framesPerSecond'],
    state.values['benchmark.averageFps'],
    state.values['benchmark.currentFps'],
    state.values['benchmark.avgFps'],
    state.values['benchmark.processingFps'],
    state.values['benchmark.pipelineFps'],
    state.values['benchmark.videoFps'],
    state.values['benchmark.average_fps'],
    state.values['benchmark.current_fps'],
    state.values['benchmark.processing_fps'],
    state.values['benchmark.pipeline_fps'],
    state.values['benchmark.video_fps'],
    state.values['fps'],
    state.values['framesPerSecond'],
    state.values['averageFps'],
    state.values['currentFps'],
    state.values['avgFps'],
    state.values['processingFps'],
    state.values['pipelineFps'],
    state.values['videoFps'],
    state.values['average_fps'],
    state.values['current_fps'],
    state.values['processing_fps'],
    state.values['pipeline_fps'],
    state.values['video_fps']
  );
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return NaN;
}

function sparklinePoints(values) {
  if (!values.length) return '';
  return sparklineCoordinates(values).join(' ');
}

function sparklineAreaPoints(values) {
  if (!values.length) return '';
  const line = sparklineCoordinates(values);
  return `0,14 ${line.join(' ')} 40,14`;
}

function sparklineCoordinates(values) {
  const width = 40;
  const height = 14;
  const maxFps = 20;
  const plottedValues = values.length === 1 ? [values[0], values[0]] : values;
  return plottedValues.map((value, index) => {
    const x = (index / (plottedValues.length - 1)) * width;
    const y = height - ((clamp(value, 0, maxFps) / maxFps) * (height - 2)) - 1;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
}

function updateVersion(version) {
  if (!version) {
    elements.versionStatus.textContent = 'Version --';
    return;
  }
  elements.versionStatus.textContent = version.releaseTag
    ? `${version.releaseTag} ${version.gitHash}`
    : `git ${version.gitHash}`;
  elements.versionStatus.title = `Gateway ${version.packageVersion}`;
}

function connectWebSocket() {
  if (!state.token || state.ws?.readyState === WebSocket.OPEN || state.ws?.readyState === WebSocket.CONNECTING) return;
  clearTimeout(state.wsReconnectTimer);
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}/api/ws?token=${encodeURIComponent(state.token)}`);
  state.ws = ws;

  ws.addEventListener('open', () => {
    state.wsConnected = true;
    setConnected(true);
  });

  ws.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (message.type === 'state') {
      const changedKeys = applyState(message.state);
      patchControls(changedKeys);
      updateBenchmark(state.values.benchmark);
      setConnected(true);
    } else if (message.type === 'state-error') {
      showMessage(message.error || 'State update failed', true);
    }
  });

  ws.addEventListener('close', () => scheduleWebSocketReconnect());
  ws.addEventListener('error', () => {
    ws.close();
  });
}

function scheduleWebSocketReconnect() {
  state.wsConnected = false;
  setConnected(false);
  clearTimeout(state.wsReconnectTimer);
  if (!state.token) return;
  state.wsReconnectTimer = setTimeout(connectWebSocket, 1500);
}

function closeWebSocket() {
  clearTimeout(state.wsReconnectTimer);
  state.wsReconnectTimer = null;
  state.wsConnected = false;
  if (state.ws) {
    state.ws.close();
    state.ws = null;
  }
}

function applyState(nextState) {
  const flat = flattenValues(nextState);
  const changedKeys = [];
  for (const [key, value] of Object.entries(flat)) {
    const pending = state.pending[key];
    if (pending) {
      if (valuesEquivalent(key, value, pending.expected)) {
        clearTimeout(pending.timer);
        delete state.pending[key];
        state.values[key] = value;
        changedKeys.push(key);
      }
      continue;
    }
    if (!valuesEquivalent(key, state.values[key], value)) changedKeys.push(key);
    state.values[key] = value;
  }
  return changedKeys;
}

function valuesEquivalent(key, actual, expected) {
  if (key.endsWith('.image')) {
    return assetIdFromValue(actual) === assetIdFromValue(expected);
  }
  if (typeof actual === 'number' || typeof expected === 'number') {
    return Math.abs(Number(actual) - Number(expected)) < 0.000001;
  }
  if (typeof actual === 'boolean' || typeof expected === 'boolean') {
    return String(actual) === String(expected);
  }
  return actual === expected;
}

function readPresets() {
  try {
    const parsed = JSON.parse(localStorage.getItem(PRESETS_KEY) || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((preset) => preset?.id && preset?.name && preset?.values && typeof preset.values === 'object');
  } catch {
    return [];
  }
}

function writePresets() {
  localStorage.setItem(PRESETS_KEY, JSON.stringify(state.presets));
}

function renderPresets() {
  elements.presetList.innerHTML = '';
  if (state.presets.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'preset-empty';
    empty.textContent = 'No presets saved';
    elements.presetList.appendChild(empty);
    return;
  }

  for (const preset of state.presets) {
    const item = document.createElement('div');
    item.className = 'preset-item';

    const applyButton = document.createElement('button');
    applyButton.className = 'preset-button';
    applyButton.textContent = preset.name;
    applyButton.title = preset.name;
    applyButton.addEventListener('click', () => applyPreset(preset.id));

    const exportButton = document.createElement('button');
    exportButton.className = 'icon-button';
    exportButton.title = 'Export preset';
    exportButton.setAttribute('aria-label', `Export preset ${preset.name}`);
    exportButton.textContent = '⇩';
    exportButton.addEventListener('click', () => exportPreset(preset));

    const deleteButton = document.createElement('button');
    deleteButton.className = 'icon-button';
    deleteButton.title = 'Delete preset';
    deleteButton.setAttribute('aria-label', `Delete preset ${preset.name}`);
    deleteButton.textContent = '×';
    deleteButton.addEventListener('click', () => deletePreset(preset.id));

    item.append(applyButton, exportButton, deleteButton);
    elements.presetList.appendChild(item);
  }
}

function currentPresetValues() {
  const items = state.schema?.api?.commands?.set?.items || {};
  const values = {};
  for (const key of Object.keys(items)) {
    if (state.values[key] !== undefined) values[key] = normalizePresetValue(key, state.values[key], items[key]);
  }
  return values;
}

function normalizePresetValue(key, value, rule) {
  if (rule?.assetRoot || key.endsWith('.image')) return assetIdFromValue(value);
  return value;
}

function savePreset(name) {
  const trimmedName = name.trim();
  if (!trimmedName) {
    showMessage('Preset name is required', true);
    return false;
  }

  const existing = state.presets.find((preset) => preset.name.toLowerCase() === trimmedName.toLowerCase());
  const preset = {
    id: existing?.id || `preset-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    name: trimmedName,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    values: currentPresetValues()
  };
  if (Object.keys(preset.values).length === 0) {
    showMessage('No settings loaded for preset', true);
    return false;
  }

  if (existing) {
    Object.assign(existing, preset);
  } else {
    state.presets.push(preset);
  }

  state.presets.sort((a, b) => a.name.localeCompare(b.name));
  writePresets();
  renderPresets();
  showMessage(`Saved preset ${trimmedName}`);
  return true;
}

async function applyPreset(id) {
  const preset = state.presets.find((item) => item.id === id);
  if (!preset) return;
  const items = state.schema?.api?.commands?.set?.items || {};
  const entries = Object.entries(preset.values || {})
    .filter(([key, value]) => items[key] && value !== undefined)
    .map(([key, value]) => [key, normalizePresetValue(key, value, items[key])]);
  if (entries.length === 0) {
    showMessage('Preset has no settings', true);
    return;
  }

  const failed = [];
  for (const [key, value] of entries) {
    if (!await setValue(key, value)) failed.push(LABELS[key] || key);
  }
  if (failed.length > 0) {
    showMessage(`Applied preset ${preset.name}; failed: ${failed.join(', ')}`, true);
  } else {
    showMessage(`Applied preset ${preset.name}`);
  }
}

function deletePreset(id) {
  const preset = state.presets.find((item) => item.id === id);
  if (!preset) return;
  if (!confirm(`Delete preset "${preset.name}"?`)) return;
  state.presets = state.presets.filter((item) => item.id !== id);
  writePresets();
  renderPresets();
  showMessage(`Deleted preset ${preset.name}`);
}

function exportPreset(preset) {
  downloadJson(`jonimageprocessor-preset-${safeFileName(preset.name)}.json`, {
    type: 'JONImageProcessorGatewayPreset',
    version: 1,
    preset
  });
}

function exportPresets() {
  downloadJson('jonimageprocessor-presets.json', {
    type: 'JONImageProcessorGatewayPresets',
    version: 1,
    presets: state.presets
  });
}

async function importPresets(file) {
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const incoming = normalizeImportedPresets(data);
    if (incoming.length === 0) throw new Error('No presets found in file');

    for (const preset of incoming) {
      const existing = state.presets.find((item) => item.name.toLowerCase() === preset.name.toLowerCase());
      const next = {
        id: existing?.id || preset.id || `preset-${Date.now()}-${Math.random().toString(16).slice(2)}`,
        name: preset.name,
        createdAt: existing?.createdAt || preset.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        values: preset.values
      };
      if (existing) Object.assign(existing, next);
      else state.presets.push(next);
    }

    state.presets.sort((a, b) => a.name.localeCompare(b.name));
    writePresets();
    renderPresets();
    showMessage(`Imported ${incoming.length} preset${incoming.length === 1 ? '' : 's'}`);
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    elements.importPresetsInput.value = '';
  }
}

function normalizeImportedPresets(data) {
  const candidates = Array.isArray(data) ? data : data.presets || (data.preset ? [data.preset] : []);
  if (!Array.isArray(candidates)) return [];
  return candidates
    .filter((preset) => preset?.name && preset?.values && typeof preset.values === 'object')
    .map((preset) => ({
      id: typeof preset.id === 'string' ? preset.id : '',
      name: String(preset.name).trim(),
      createdAt: typeof preset.createdAt === 'string' ? preset.createdAt : '',
      values: preset.values
    }))
    .filter((preset) => preset.name);
}

function downloadJson(fileName, data) {
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function safeFileName(value) {
  return String(value).trim().replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '') || 'preset';
}

function render() {
  const items = state.schema?.api?.commands?.set?.items || {};
  elements.stages.innerHTML = '';
  for (const stage of STAGES) {
    const section = document.createElement('section');
    section.className = 'stage';
    section.innerHTML = `<h2>${stage.title}</h2>`;

    for (const key of stage.keys) {
      if (!items[key]) continue;
      section.appendChild(renderControl(key, items[key]));
    }

    elements.stages.appendChild(section);
  }
  state.rendered = true;
}

function renderControl(key, rule) {
  if (rule.assetRoot) return renderAssetControl(key, rule);
  if (rule.type === 'boolean') return renderBooleanControl(key);
  if (SELECT_ENUM_KEYS.has(key)) return renderSelectEnumControl(key, rule);
  if (rule.enum) return renderEnumControl(key, rule);
  if (key === 'pause.textSize') return renderPauseTextLayoutControl(key, rule);
  if (rule.type === 'number' || rule.type === 'integer') return renderNumberControl(key, rule);
  if (key === 'background.overlayColor') return renderOverlayRgbaControl(key);
  if (key === 'pause.textColor') return renderRgbaControl(key);
  if (key === 'pause.textPosition') return renderPositionControl(key, rule);
  return renderTextControl(key, rule);
}

function renderSelectEnumControl(key, rule) {
  const control = controlShell(key);
  control.dataset.kind = 'select-enum';
  const select = document.createElement('select');
  for (const option of rule.enum) {
    select.appendChild(new Option(title(option), option));
  }
  select.value = state.values[key] || rule.enum[0] || '';
  select.addEventListener('change', () => setValue(key, select.value));
  control.appendChild(select);
  return control;
}

function updateSelectEnumControl(control, key) {
  const select = control.querySelector('select');
  if (select && document.activeElement !== select) select.value = state.values[key] || '';
}

function controlShell(key, rangeText = '') {
  const control = document.createElement('div');
  control.className = 'control';
  control.dataset.key = key;
  control.classList.toggle('pending', Boolean(state.pending[key]));
  const label = document.createElement('div');
  label.className = 'label';
  label.innerHTML = `<span>${LABELS[key] || key}</span><span>${rangeText}</span>`;
  control.appendChild(label);
  return control;
}

function patchControls(keys) {
  if (!state.rendered) return;
  const uniqueKeys = keys?.length ? [...new Set(expandPatchKeys(keys))] : Object.keys(state.values);
  for (const key of uniqueKeys) {
    const control = document.querySelector(`.control[data-key="${cssEscape(key)}"]`);
    if (!control) continue;
    control.classList.toggle('pending', Boolean(state.pending[key]));
    if (controlIsBusy(control, key)) continue;
    const kind = control.dataset.kind;
    if (kind === 'boolean') updateBooleanControl(control, key);
    else if (kind === 'enum') updateEnumControl(control, key);
    else if (kind === 'select-enum') updateSelectEnumControl(control, key);
    else if (kind === 'number') updateNumberControl(control, key);
    else if (kind === 'rgb') updateRgbControl(control, key);
    else if (kind === 'rgba') updateRgbaControl(control, key);
    else if (kind === 'overlay-rgba') updateOverlayRgbaControl(control);
    else if (kind === 'position') updatePositionControl(control, key);
    else if (kind === 'pause-text-layout') updatePauseTextLayoutControl(control);
    else if (kind === 'asset') updateAssetControl(control, key);
    else if (kind === 'text') updateTextControl(control, key);
  }
}

function expandPatchKeys(keys) {
  const expanded = [];
  for (const key of keys) {
    expanded.push(key);
    if (key === 'background.overlayAlpha') expanded.push('background.overlayColor');
    if (key === 'pause.textPosition') expanded.push('pause.textSize');
  }
  return expanded;
}

function controlIsBusy(control, key) {
  return Boolean(state.pending[key]) || control.dataset.dragging === 'true' || control.contains(document.activeElement);
}

function cssEscape(value) {
  return String(value).replace(/["\\]/g, '\\$&');
}

function renderBooleanControl(key) {
  const control = controlShell(key);
  control.dataset.kind = 'boolean';
  const group = document.createElement('div');
  group.className = 'toggle';
  const value = Boolean(state.values[key]);
  const effective = BOOLEAN_INVERTED.has(key) ? !value : value;
  for (const option of [true, false]) {
    const button = document.createElement('button');
    button.textContent = option ? 'ON' : 'OFF';
    button.dataset.value = String(option);
    button.classList.toggle('active', effective === option);
    button.addEventListener('click', () => setValue(key, BOOLEAN_INVERTED.has(key) ? !option : option));
    group.appendChild(button);
  }
  control.appendChild(group);
  return control;
}

function updateBooleanControl(control, key) {
  const value = Boolean(state.values[key]);
  const effective = BOOLEAN_INVERTED.has(key) ? !value : value;
  control.querySelectorAll('button[data-value]').forEach((button) => {
    button.classList.toggle('active', button.dataset.value === String(effective));
  });
}

function renderEnumControl(key, rule) {
  const control = controlShell(key);
  control.dataset.kind = 'enum';
  const group = document.createElement('div');
  group.className = 'enum';
  for (const option of rule.enum) {
    const button = document.createElement('button');
    button.textContent = title(option);
    button.dataset.value = option;
    button.classList.toggle('active', state.values[key] === option);
    button.addEventListener('click', () => setValue(key, option));
    group.appendChild(button);
  }
  control.appendChild(group);
  return control;
}

function updateEnumControl(control, key) {
  const value = String(state.values[key]);
  control.querySelectorAll('button[data-value]').forEach((button) => {
    button.classList.toggle('active', button.dataset.value === value);
  });
}

function renderNumberControl(key, rule) {
  const min = rule.min ?? 0;
  const max = rule.max ?? 100;
  const step = numberStep(key, rule);
  const value = Number(state.values[key] ?? min);
  const control = controlShell(key, `${min} bis ${max}`);
  control.dataset.kind = 'number';
  const wrap = document.createElement('div');
  wrap.className = 'knob-wrap';
  const knob = document.createElement('div');
  knob.className = 'knob';
  knob.dataset.min = min;
  knob.dataset.max = max;
  knob.dataset.step = step;
  knob.dataset.value = value;
  const input = document.createElement('input');
  input.className = 'knob-value';
  input.type = 'number';
  input.min = min;
  input.max = max;
  input.step = step;
  input.value = value;
  wrap.append(knob, input);
  control.appendChild(wrap);
  buildKnob(knob, (nextValue) => setValue(key, rule.type === 'integer' ? Math.round(nextValue) : nextValue));
  return control;
}

function numberStep(key, rule) {
  if (key === 'segmentation.threshold') return 0.001;
  return Number(rule.step ?? rule.ui?.step ?? (rule.type === 'integer' ? 1 : 0.01));
}

function updateNumberControl(control, key) {
  const value = Number(state.values[key]);
  if (!Number.isFinite(value)) return;
  const knob = control.querySelector('.knob');
  if (knob?.setDisplayValue) knob.setDisplayValue(value);
  const input = control.querySelector('.knob-value');
  if (input && document.activeElement !== input) input.value = knob?.dataset.value ?? String(value);
}

function renderRgbControl(key) {
  const value = String(state.values[key] || '0,255,0').split(',').map((part) => Number(part));
  const control = controlShell(key, '0 bis 255');
  control.dataset.kind = 'rgb';
  const rgb = document.createElement('div');
  rgb.className = 'rgb';
  const preview = document.createElement('div');
  preview.className = 'color-preview';
  const channels = [
    { label: 'R', color: '#ff4b4b' },
    { label: 'G', color: '#38d878' },
    { label: 'B', color: '#4da3ff' }
  ];
  const inputs = channels.map((channel, index) => {
    const item = document.createElement('div');
    item.className = 'rgb-knob';
    const label = document.createElement('label');
    label.textContent = channel.label;
    const knob = document.createElement('div');
    knob.className = 'knob small';
    knob.style.setProperty('--knob-accent', channel.color);
    knob.dataset.min = 0;
    knob.dataset.max = 255;
    knob.dataset.step = 1;
    knob.dataset.value = Number.isFinite(value[index]) ? value[index] : 0;
    const input = document.createElement('input');
    input.className = 'knob-value';
    input.type = 'number';
    input.min = 0;
    input.max = 255;
    input.step = 1;
    input.value = Number.isFinite(value[index]) ? value[index] : 0;
    function commitRgb(nextValue) {
      if (Number.isFinite(nextValue)) input.value = clamp(nextValue, 0, 255);
      const next = inputs.map((item) => clamp(Number(item.value), 0, 255));
      preview.style.background = `rgb(${next.join(',')})`;
      setValue(key, next.join(','));
    }
    input.addEventListener('change', commitRgb);
    item.append(label, knob, input);
    rgb.appendChild(item);
    buildKnob(knob, commitRgb);
    return input;
  });
  preview.style.background = `rgb(${inputs.map((item) => item.value).join(',')})`;
  control.append(rgb, preview);
  return control;
}

function updateRgbControl(control, key) {
  const value = String(state.values[key] || '0,255,0').split(',').map((part) => clamp(Number(part), 0, 255));
  control.querySelectorAll('.rgb-knob').forEach((item, index) => {
    const input = item.querySelector('input');
    const knob = item.querySelector('.knob');
    const nextValue = Number.isFinite(value[index]) ? value[index] : 0;
    if (knob?.setDisplayValue) knob.setDisplayValue(nextValue);
    if (document.activeElement !== input) input.value = Number.isFinite(value[index]) ? value[index] : 0;
  });
  const preview = control.querySelector('.color-preview');
  if (preview) preview.style.background = `rgb(${value.map((part) => Number.isFinite(part) ? part : 0).join(',')})`;
}

function renderRgbaControl(key) {
  const value = parseRgbaHex(state.values[key]);
  const control = controlShell(key, '0 bis 255');
  control.dataset.kind = 'rgba';
  const rgba = document.createElement('div');
  rgba.className = 'rgba';
  const preview = document.createElement('div');
  preview.className = 'color-preview alpha-preview';
  const channels = [
    { label: 'R', color: '#ff4b4b' },
    { label: 'G', color: '#38d878' },
    { label: 'B', color: '#4da3ff' },
    { label: 'A', color: '#f2f5f8' }
  ];
  const inputs = channels.map((channel, index) => {
    const item = document.createElement('div');
    item.className = 'rgba-knob';
    const label = document.createElement('label');
    label.textContent = channel.label;
    const knob = document.createElement('div');
    knob.className = 'knob tiny';
    knob.style.setProperty('--knob-accent', channel.color);
    knob.dataset.min = 0;
    knob.dataset.max = 255;
    knob.dataset.step = 1;
    knob.dataset.value = value[index];
    const input = document.createElement('input');
    input.className = 'knob-value';
    input.type = 'number';
    input.min = 0;
    input.max = 255;
    input.step = 1;
    input.value = value[index];
    function commitRgba(nextValue) {
      if (Number.isFinite(nextValue)) input.value = clamp(nextValue, 0, 255);
      const next = inputs.map((item) => Math.round(clamp(Number(item.value), 0, 255)));
      updateRgbaPreview(preview, next);
      setValue(key, rgbaToHex(next));
    }
    input.addEventListener('change', commitRgba);
    item.append(label, knob, input);
    rgba.appendChild(item);
    buildKnob(knob, commitRgba);
    return input;
  });
  updateRgbaPreview(preview, value);
  control.append(rgba, preview);
  return control;
}

function updateRgbaControl(control, key) {
  const value = parseRgbaHex(state.values[key]);
  control.querySelectorAll('.rgba-knob').forEach((item, index) => {
    const input = item.querySelector('input');
    const knob = item.querySelector('.knob');
    if (knob?.setDisplayValue) knob.setDisplayValue(value[index]);
    if (input && document.activeElement !== input) input.value = value[index];
  });
  const preview = control.querySelector('.color-preview');
  if (preview) updateRgbaPreview(preview, value);
}

function renderOverlayRgbaControl(key) {
  const value = overlayRgbaValue();
  const control = controlShell(key, '0 bis 255');
  control.dataset.kind = 'overlay-rgba';
  const rgba = document.createElement('div');
  rgba.className = 'rgba';
  const preview = document.createElement('div');
  preview.className = 'color-preview alpha-preview';
  const channels = [
    { label: 'R', color: '#ff4b4b' },
    { label: 'G', color: '#38d878' },
    { label: 'B', color: '#4da3ff' },
    { label: 'A', color: '#f2f5f8' }
  ];
  const inputs = channels.map((channel, index) => {
    const item = document.createElement('div');
    item.className = 'rgba-knob';
    const label = document.createElement('label');
    label.textContent = channel.label;
    const knob = document.createElement('div');
    knob.className = 'knob tiny';
    knob.style.setProperty('--knob-accent', channel.color);
    knob.dataset.min = 0;
    knob.dataset.max = 255;
    knob.dataset.step = 1;
    knob.dataset.value = value[index];
    const input = document.createElement('input');
    input.className = 'knob-value';
    input.type = 'number';
    input.min = 0;
    input.max = 255;
    input.step = 1;
    input.value = value[index];
    function commitOverlay(nextValue) {
      if (Number.isFinite(nextValue)) input.value = clamp(nextValue, 0, 255);
      const next = inputs.map((item) => Math.round(clamp(Number(item.value), 0, 255)));
      updateRgbaPreview(preview, next);
      setValue(key, next.slice(0, 3).join(','));
      setValue('background.overlayAlpha', Number((next[3] / 255).toFixed(4)));
    }
    input.addEventListener('change', commitOverlay);
    item.append(label, knob, input);
    rgba.appendChild(item);
    buildKnob(knob, commitOverlay);
    return input;
  });
  updateRgbaPreview(preview, value);
  control.append(rgba, preview);
  return control;
}

function updateOverlayRgbaControl(control) {
  const value = overlayRgbaValue();
  control.querySelectorAll('.rgba-knob').forEach((item, index) => {
    const input = item.querySelector('input');
    const knob = item.querySelector('.knob');
    if (knob?.setDisplayValue) knob.setDisplayValue(value[index]);
    if (input && document.activeElement !== input) input.value = value[index];
  });
  const preview = control.querySelector('.color-preview');
  if (preview) updateRgbaPreview(preview, value);
}

function overlayRgbaValue() {
  const rgb = String(state.values['background.overlayColor'] || '0,255,0')
    .split(',')
    .map((part) => Math.round(clamp(Number(part), 0, 255)));
  while (rgb.length < 3) rgb.push(0);
  const alpha = Math.round(clamp(Number(state.values['background.overlayAlpha'] ?? 1), 0, 1) * 255);
  return [rgb[0], rgb[1], rgb[2], alpha];
}

function parseRgbaHex(value) {
  const text = String(value || '').trim();
  const hex = /^[0-9a-fA-F]{8}$/.test(text) ? text : 'ffffffff';
  return [0, 2, 4, 6].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
}

function rgbaToHex(values) {
  return values.map((value) => Math.round(clamp(Number(value), 0, 255)).toString(16).padStart(2, '0')).join('');
}

function updateRgbaPreview(preview, values) {
  const [r, g, b, a] = values.map((value) => Math.round(clamp(Number(value), 0, 255)));
  preview.style.setProperty('--preview-color', `rgba(${r}, ${g}, ${b}, ${(a / 255).toFixed(3)})`);
}

function renderPauseTextLayoutControl(key, rule) {
  const positionRule = state.schema?.api?.commands?.set?.items?.['pause.textPosition'] || {};
  const limits = positionLimits(positionRule);
  const position = parsePositionValue(state.values['pause.textPosition']);
  const size = Number(state.values[key] ?? rule.min ?? 1);
  const sizeLimits = {
    min: Number(rule.min ?? 0.1),
    max: Number(rule.max ?? 10),
    step: rule.type === 'integer' ? 1 : 0.1
  };
  const control = controlShell(key, `Size ${sizeLimits.min} bis ${sizeLimits.max}, X/Y`);
  control.dataset.kind = 'pause-text-layout';
  const wrap = document.createElement('div');
  wrap.className = 'pause-text-knobs';
  const channels = [
    { key: 'pause.textSize', axis: 'size', label: 'Size', limits: sizeLimits, value: size },
    { key: 'pause.textPosition', axis: 'x', label: 'X', limits: limits.x, value: position.x },
    { key: 'pause.textPosition', axis: 'y', label: 'Y', limits: limits.y, value: position.y }
  ];

  for (const channel of channels) {
    const item = document.createElement('div');
    item.className = 'pause-text-knob';
    item.dataset.axis = channel.axis;
    const label = document.createElement('label');
    label.textContent = channel.label;
    const knob = document.createElement('div');
    knob.className = 'knob small';
    knob.dataset.min = channel.limits.min;
    knob.dataset.max = channel.limits.max;
    knob.dataset.step = channel.limits.step;
    knob.dataset.value = Number.isFinite(channel.value) ? channel.value : channel.limits.min;
    const input = document.createElement('input');
    input.className = 'knob-value';
    input.type = 'number';
    input.min = channel.limits.min;
    input.max = channel.limits.max;
    input.step = channel.limits.step;
    input.value = Number.isFinite(channel.value) ? channel.value : channel.limits.min;
    function commitPauseText(nextValue) {
      if (Number.isFinite(nextValue)) input.value = clamp(nextValue, channel.limits.min, channel.limits.max);
      if (channel.axis === 'size') {
        setValue('pause.textSize', Number(input.value));
        return;
      }
      const next = pauseTextPositionValues(wrap);
      setValue('pause.textPosition', `${next.x}x${next.y}`);
    }
    item.append(label, knob, input);
    wrap.appendChild(item);
    buildKnob(knob, commitPauseText);
  }

  control.appendChild(wrap);
  return control;
}

function updatePauseTextLayoutControl(control) {
  const position = parsePositionValue(state.values['pause.textPosition']);
  const values = {
    size: Number(state.values['pause.textSize']),
    x: position.x,
    y: position.y
  };
  control.querySelectorAll('.pause-text-knob').forEach((item) => {
    const axis = item.dataset.axis;
    const input = item.querySelector('input');
    const knob = item.querySelector('.knob');
    const fallback = Number(input?.min || 0);
    const nextValue = Number.isFinite(values[axis]) ? values[axis] : fallback;
    if (knob?.setDisplayValue) knob.setDisplayValue(nextValue);
    if (input && document.activeElement !== input) input.value = knob?.dataset.value ?? String(nextValue);
  });
}

function pauseTextPositionValues(wrap) {
  const xInput = wrap.querySelector('.pause-text-knob[data-axis="x"] input');
  const yInput = wrap.querySelector('.pause-text-knob[data-axis="y"] input');
  return {
    x: Math.round(clamp(Number(xInput?.value), Number(xInput?.min || 0), Number(xInput?.max || 1920))),
    y: Math.round(clamp(Number(yInput?.value), Number(yInput?.min || 0), Number(yInput?.max || 1080)))
  };
}

function renderPositionControl(key, rule) {
  const limits = positionLimits(rule);
  const value = parsePositionValue(state.values[key]);
  const control = controlShell(key, `${limits.x.min} bis ${limits.x.max}, ${limits.y.min} bis ${limits.y.max}`);
  control.dataset.kind = 'position';
  const wrap = document.createElement('div');
  wrap.className = 'position-knobs';
  const inputs = [
    { axis: 'x', label: 'X', limits: limits.x, value: value.x },
    { axis: 'y', label: 'Y', limits: limits.y, value: value.y }
  ].map((channel) => {
    const item = document.createElement('div');
    item.className = 'position-knob';
    item.dataset.axis = channel.axis;
    const label = document.createElement('label');
    label.textContent = channel.label;
    const knob = document.createElement('div');
    knob.className = 'knob small';
    knob.dataset.min = channel.limits.min;
    knob.dataset.max = channel.limits.max;
    knob.dataset.step = channel.limits.step;
    knob.dataset.value = Number.isFinite(channel.value) ? channel.value : channel.limits.min;
    const input = document.createElement('input');
    input.className = 'knob-value';
    input.type = 'number';
    input.min = channel.limits.min;
    input.max = channel.limits.max;
    input.step = channel.limits.step;
    input.value = Number.isFinite(channel.value) ? channel.value : channel.limits.min;
    function commitPosition(nextValue) {
      if (Number.isFinite(nextValue)) input.value = clamp(nextValue, channel.limits.min, channel.limits.max);
      const next = inputs.map((item) => Math.round(clamp(Number(item.value), Number(item.min), Number(item.max))));
      setValue(key, `${next[0]}x${next[1]}`);
    }
    item.append(label, knob, input);
    wrap.appendChild(item);
    buildKnob(knob, commitPosition);
    return input;
  });
  control.appendChild(wrap);
  return control;
}

function updatePositionControl(control, key) {
  const value = parsePositionValue(state.values[key]);
  control.querySelectorAll('.position-knob').forEach((item) => {
    const axis = item.dataset.axis;
    const input = item.querySelector('input');
    const knob = item.querySelector('.knob');
    const fallback = Number(input?.min || 0);
    const nextValue = Number.isFinite(value[axis]) ? value[axis] : fallback;
    if (knob?.setDisplayValue) knob.setDisplayValue(nextValue);
    if (input && document.activeElement !== input) input.value = Math.round(nextValue);
  });
}

function parsePositionValue(value) {
  const match = String(value || '').match(/^(\d+)x(\d+)$/);
  return match ? { x: Number(match[1]), y: Number(match[2]) } : { x: 0, y: 0 };
}

function positionLimits(rule) {
  return {
    x: {
      min: Number(rule.ui?.position?.x?.min ?? 0),
      max: Number(rule.ui?.position?.x?.max ?? 1920),
      step: Number(rule.ui?.position?.x?.step ?? 10)
    },
    y: {
      min: Number(rule.ui?.position?.y?.min ?? 0),
      max: Number(rule.ui?.position?.y?.max ?? 1080),
      step: Number(rule.ui?.position?.y?.step ?? 10)
    }
  };
}

function renderTextControl(key) {
  const control = controlShell(key);
  control.dataset.kind = 'text';
  const input = document.createElement('input');
  input.type = 'text';
  input.value = state.values[key] || '';
  input.addEventListener('change', () => setValue(key, input.value));
  control.appendChild(input);
  return control;
}

function updateTextControl(control, key) {
  const input = control.querySelector('input');
  if (input && document.activeElement !== input) input.value = state.values[key] || '';
}

function renderAssetControl(key, rule) {
  const control = controlShell(key);
  control.dataset.kind = 'asset';
  const root = rule.assetRoot;
  const row = document.createElement('div');
  row.className = 'asset-row';
  const assets = state.assets[root] || [];
  const selectedAsset = assetIdFromValue(state.values[key]);
  const picker = buildAssetPicker(control, root, selectedAsset, (assetId) => {
    updateAssetDetail(control, root, assetId);
    if (assetId) setValue(key, assetId);
  });
  const deleteButton = document.createElement('button');
  deleteButton.className = 'action';
  deleteButton.textContent = 'Delete';
  deleteButton.disabled = !selectedAsset;
  deleteButton.addEventListener('click', () => deleteAsset(root, getAssetSelection(control)));
  row.append(picker, deleteButton);

  const upload = document.createElement('div');
  upload.className = 'upload-row';
  const file = document.createElement('input');
  file.type = 'file';
  file.accept = '.zip,application/zip';
  file.className = 'hidden-file';
  file.addEventListener('change', () => {
    uploadAsset(root, file.files[0]).finally(() => {
      file.value = '';
    });
  });
  const uploadButton = document.createElement('button');
  uploadButton.className = 'action upload-button';
  uploadButton.textContent = 'Upload ZIP';
  uploadButton.addEventListener('click', () => file.click());
  upload.append(file, uploadButton);
  const detail = document.createElement('div');
  detail.className = 'asset-detail';
  control.append(row, detail, upload);
  updateAssetDetail(control, root, selectedAsset);
  return control;
}

function updateAssetControl(control, key) {
  const selectedAsset = assetIdFromValue(state.values[key]);
  setAssetSelection(control, selectedAsset);
  const deleteButton = control.querySelector('button.action');
  if (deleteButton) deleteButton.disabled = !selectedAsset;
  const rule = state.schema?.api?.commands?.set?.items?.[key];
  updateAssetDetail(control, rule?.assetRoot, selectedAsset);
}

function refreshAssetControls(roots) {
  if (!roots?.length || !state.rendered) return;
  const rootSet = new Set(roots);
  const items = state.schema?.api?.commands?.set?.items || {};
  for (const [key, rule] of Object.entries(items)) {
    if (!rule.assetRoot || !rootSet.has(rule.assetRoot)) continue;
    const control = document.querySelector(`.control[data-key="${cssEscape(key)}"]`);
    if (!control) continue;
    control.replaceWith(renderControl(key, rule));
  }
}

function buildAssetPicker(control, root, selectedAsset, onSelect) {
  const picker = document.createElement('div');
  picker.className = 'asset-picker';
  picker.dataset.root = root;
  picker.dataset.selected = selectedAsset || '';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'asset-picker-button';
  const menu = document.createElement('div');
  menu.className = 'asset-menu';
  menu.hidden = true;

  const empty = document.createElement('button');
  empty.type = 'button';
  empty.className = 'asset-option';
  empty.dataset.assetId = '';
  empty.innerHTML = '<b>Select asset</b><span>No asset selected</span>';
  empty.addEventListener('click', () => {
    setAssetSelection(control, '');
    menu.hidden = true;
    onSelect('');
  });
  menu.appendChild(empty);

  for (const asset of state.assets[root] || []) {
    const option = document.createElement('button');
    option.type = 'button';
    option.className = 'asset-option';
    option.dataset.assetId = asset.id;
    option.innerHTML = assetOptionHtml(asset);
    option.addEventListener('click', () => {
      setAssetSelection(control, asset.id);
      menu.hidden = true;
      onSelect(asset.id);
    });
    menu.appendChild(option);
  }

  button.addEventListener('click', () => {
    closeAssetMenus(picker);
    menu.hidden = !menu.hidden;
  });

  picker.append(button, menu);
  setAssetSelectionElement(picker, selectedAsset);
  return picker;
}

function closeAssetMenus(except) {
  document.querySelectorAll('.asset-picker').forEach((picker) => {
    if (picker !== except) {
      const menu = picker.querySelector('.asset-menu');
      if (menu) menu.hidden = true;
    }
  });
}

function getAssetSelection(control) {
  return control.querySelector('.asset-picker')?.dataset.selected || '';
}

function setAssetSelection(control, assetId) {
  const picker = control.querySelector('.asset-picker');
  if (picker) setAssetSelectionElement(picker, assetId);
}

function setAssetSelectionElement(picker, assetId) {
  const root = picker.dataset.root;
  const asset = (state.assets[root] || []).find((item) => item.id === assetId);
  picker.dataset.selected = asset?.id || '';
  const button = picker.querySelector('.asset-picker-button');
  if (button) {
    button.innerHTML = asset ? assetOptionHtml(asset) : '<b>Select asset</b><span>No asset selected</span>';
  }
  picker.querySelectorAll('.asset-option').forEach((option) => {
    option.classList.toggle('active', option.dataset.assetId === picker.dataset.selected);
  });
}

function assetOptionHtml(asset) {
  return `<b>${escapeHtml(asset.name)} (${escapeHtml(asset.type)})</b><span>${escapeHtml(asset.description || '')}</span>`;
}

function updateAssetDetail(control, root, assetId) {
  const detail = control.querySelector('.asset-detail');
  if (!detail) return;
  const asset = (state.assets[root] || []).find((item) => item.id === assetId);
  if (!asset) {
    detail.innerHTML = '<span>No asset selected</span>';
    return;
  }
  detail.innerHTML = assetOptionHtml(asset);
}

function assetIdFromValue(value) {
  if (!value || typeof value !== 'string') return '';
  return value.split('/')[0];
}

async function setValue(key, value) {
  const previous = state.values[key];
  clearTimeout(state.pending[key]?.timer);
  state.values[key] = value;
  state.pending[key] = {
    expected: value,
    previous,
    timer: setTimeout(() => {
      state.values[key] = previous;
      delete state.pending[key];
      patchControls([key]);
      showMessage(`${LABELS[key] || key} did not confirm in time`, true);
    }, state.confirmTimeoutMs)
  };
  patchControls([key]);

  try {
    await ipc({ cmd: 'set', key, value });
    clearTimeout(state.pending[key]?.timer);
    delete state.pending[key];
    patchControls([key]);
    if (!state.wsConnected) {
      const changedKeys = await loadValues();
      patchControls(changedKeys);
    }
    showMessage(`${LABELS[key] || key} sent`);
    return true;
  } catch (error) {
    clearTimeout(state.pending[key]?.timer);
    state.values[key] = previous;
    delete state.pending[key];
    patchControls([key]);
    showMessage(error.message, true);
    return false;
  }
}

async function uploadAsset(root, file) {
  if (!file) {
    showMessage('Select a ZIP file first', true);
    return;
  }
  try {
    const response = await fetch(`/api/files/${encodeURIComponent(root)}/${encodeURIComponent(file.name)}`, {
      method: 'PUT',
      headers: authHeaders(),
      body: file
    });
    const data = await response.json();
    if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
    await refresh(false);
    showMessage(`Uploaded ${file.name}`);
  } catch (error) {
    showMessage(error.message, true);
  }
}

async function deleteAsset(root, assetId) {
  if (!assetId) return;
  if (!confirm(`Delete asset "${assetId}"?`)) return;
  try {
    await apiFetch(`/api/files/${encodeURIComponent(root)}/${encodeURIComponent(assetId)}`, { method: 'DELETE' });
    await refresh(false);
    showMessage(`Deleted ${assetId}`);
  } catch (error) {
    showMessage(error.message, true);
  }
}

async function refresh(showOk = true) {
  if (!state.token) {
    setConnected(false);
    elements.settingsDialog.showModal();
    return;
  }
  try {
    if (!state.schema) await loadSchema();
    const changedAssetRoots = await loadAssets();
    const changedKeys = await loadValues();
    if (!state.rendered) render();
    else {
      refreshAssetControls(changedAssetRoots);
      patchControls(changedKeys);
    }
    connectWebSocket();
    setConnected(true);
    if (showOk) showMessage('State refreshed');
  } catch (error) {
    setConnected(false);
    showMessage(error.message, true);
    if (String(error.message).includes('Unauthorized')) elements.settingsDialog.showModal();
  }
}

function title(value) {
  return String(value).replace(/[-_]/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function polarToCartesian(cx, cy, r, angleDeg) {
  const angleRad = (angleDeg - 90) * Math.PI / 180;
  return { x: cx + r * Math.cos(angleRad), y: cy + r * Math.sin(angleRad) };
}

function describeArc(cx, cy, r, startAngle, endAngle) {
  const start = polarToCartesian(cx, cy, r, endAngle);
  const end = polarToCartesian(cx, cy, r, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? '0' : '1';
  return ['M', start.x, start.y, 'A', r, r, 0, largeArcFlag, 0, end.x, end.y].join(' ');
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function valueToAngle(value, min, max) {
  const t = (value - min) / (max - min);
  return -135 + (t * 270);
}

function decimalsFromStep(step) {
  const text = String(step);
  return text.includes('.') ? text.split('.')[1].length : 0;
}

function buildKnob(knob, onCommit) {
  const min = Number(knob.dataset.min);
  const max = Number(knob.dataset.max);
  const step = Number(knob.dataset.step);
  const decimals = decimalsFromStep(step);
  const dragSensitivity = Math.min((max - min) / 160, step);

  knob.innerHTML = `
    <svg viewBox="0 0 120 120">
      <path class="knob-range" d="${describeArc(60, 60, 48, -135, 135)}"></path>
      <path class="knob-value-arc"></path>
      <circle cx="60" cy="60" r="40" class="knob-bg"></circle>
      <circle cx="60" cy="60" r="30" class="knob-inner"></circle>
      <line class="knob-pointer" x1="60" y1="60" x2="60" y2="30"></line>
      <circle cx="60" cy="60" r="4" class="knob-dot"></circle>
    </svg>
  `;

  const input = knob.parentElement.querySelector('.knob-value');
  const pointer = knob.querySelector('.knob-pointer');
  const valueArc = knob.querySelector('.knob-value-arc');

  function setDisplay(rawValue) {
    let value = clamp(rawValue, min, max);
    value = Math.round(value / step) * step;
    value = Number(value.toFixed(decimals));
    knob.dataset.value = value;
    input.value = value.toFixed(decimals);
    const angle = valueToAngle(value, min, max);
    pointer.setAttribute('transform', `rotate(${angle} 60 60)`);
    valueArc.setAttribute('d', value <= min ? '' : describeArc(60, 60, 48, -135, angle));
  }
  knob.setDisplayValue = setDisplay;

  function commit() {
    onCommit(Number(knob.dataset.value), knob);
  }

  setDisplay(Number(knob.dataset.value));
  input.addEventListener('change', () => {
    setDisplay(Number(input.value));
    commit();
  });

  let dragging = false;
  let startY = 0;
  let startValue = 0;

  knob.addEventListener('pointerdown', (event) => {
    dragging = true;
    knob.closest('.control').dataset.dragging = 'true';
    startY = event.clientY;
    startValue = Number(knob.dataset.value);
    knob.setPointerCapture(event.pointerId);
  });

  knob.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const delta = startY - event.clientY;
    setDisplay(startValue + (delta * dragSensitivity));
  });

  knob.addEventListener('pointerup', (event) => {
    dragging = false;
    knob.closest('.control').dataset.dragging = 'false';
    knob.releasePointerCapture(event.pointerId);
    commit();
  });

  knob.addEventListener('wheel', (event) => {
    event.preventDefault();
    const direction = event.deltaY < 0 ? 1 : -1;
    setDisplay(Number(knob.dataset.value) + (direction * step));
    commit();
  }, { passive: false });
}

elements.settingsButton.addEventListener('click', () => {
  elements.tokenInput.value = state.token;
  elements.confirmTimeoutInput.value = state.confirmTimeoutMs;
  elements.settingsDialog.showModal();
});

elements.savePresetButton.addEventListener('click', () => {
  elements.presetNameInput.value = '';
  elements.presetDialog.showModal();
  elements.presetNameInput.focus();
});

elements.confirmSavePresetButton.addEventListener('click', (event) => {
  event.preventDefault();
  if (savePreset(elements.presetNameInput.value)) elements.presetDialog.close();
});

elements.importPresetsButton.addEventListener('click', () => {
  elements.importPresetsInput.click();
});

elements.importPresetsInput.addEventListener('change', () => {
  importPresets(elements.importPresetsInput.files[0]);
});

elements.exportPresetsButton.addEventListener('click', () => exportPresets());

elements.refreshButton.addEventListener('click', () => refresh());

document.addEventListener('click', (event) => {
  if (!event.target.closest('.asset-picker')) closeAssetMenus();
});

elements.showTokenInput.addEventListener('change', () => {
  elements.tokenInput.type = elements.showTokenInput.checked ? 'text' : 'password';
});

elements.saveTokenButton.addEventListener('click', (event) => {
  event.preventDefault();
  state.token = elements.tokenInput.value.trim();
  state.confirmTimeoutMs = clamp(Number(elements.confirmTimeoutInput.value), 500, 15000);
  localStorage.setItem(TOKEN_KEY, state.token);
  localStorage.setItem(CONFIRM_TIMEOUT_KEY, String(state.confirmTimeoutMs));
  state.schema = null;
  closeWebSocket();
  elements.settingsDialog.close();
  refresh();
});

elements.clearTokenButton.addEventListener('click', (event) => {
  event.preventDefault();
  state.token = '';
  localStorage.removeItem(TOKEN_KEY);
  elements.tokenInput.value = '';
  state.schema = null;
  closeWebSocket();
  setConnected(false);
});

renderPresets();
refresh(false);
