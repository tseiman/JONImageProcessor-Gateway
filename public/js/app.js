const TOKEN_KEY = 'jonGatewayToken';

const state = {
  token: localStorage.getItem(TOKEN_KEY) || '',
  schema: null,
  values: {},
  assets: { backgrounds: [], pause: [] },
  busy: false
};

const elements = {
  stages: document.querySelector('#stages'),
  message: document.querySelector('#message'),
  connectionStatus: document.querySelector('#connectionStatus'),
  fpsStatus: document.querySelector('#fpsStatus'),
  latencyStatus: document.querySelector('#latencyStatus'),
  ipcStatus: document.querySelector('#ipcStatus'),
  settingsButton: document.querySelector('#settingsButton'),
  refreshButton: document.querySelector('#refreshButton'),
  settingsDialog: document.querySelector('#settingsDialog'),
  tokenInput: document.querySelector('#tokenInput'),
  showTokenInput: document.querySelector('#showTokenInput'),
  saveTokenButton: document.querySelector('#saveTokenButton'),
  clearTokenButton: document.querySelector('#clearTokenButton')
};

const STAGES = [
  {
    title: 'INPUT',
    keys: ['camera.enabled'],
    extras: ['refresh']
  },
  {
    title: 'MASK',
    keys: ['runtime.noMask', 'segmentation.threshold', 'segmentation.smoothing', 'segmentation.morphology']
  },
  {
    title: 'BACKGROUND',
    keys: ['background.effect', 'background.blurStrength', 'background.image', 'background.loopIfVideo']
  },
  {
    title: 'OVERLAY',
    keys: ['runtime.noOverlay', 'background.overlayAlpha', 'background.overlayColor']
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
  'runtime.noOverlay': 'Enable Overlay',
  'background.overlayAlpha': 'Alpha',
  'background.overlayColor': 'RGB Color',
  'pause.enabled': 'Pause Image',
  'pause.image': 'Pause Asset',
  'pause.loopIfVideo': 'Loop Pause Video',
  'pause.showStatusText': 'Status Text',
  'pause.textColor': 'Text Color',
  'pause.textSize': 'Text Size',
  'pause.font': 'Font'
};

const BOOLEAN_INVERTED = new Set(['runtime.noMask', 'runtime.noOverlay']);

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
  elements.message.hidden = false;
  elements.message.textContent = text;
  elements.message.classList.toggle('error', error);
  clearTimeout(showMessage.timer);
  showMessage.timer = setTimeout(() => {
    elements.message.hidden = true;
  }, error ? 7000 : 3000);
}

function setConnected(connected) {
  elements.connectionStatus.textContent = connected ? '● Connected' : '● Disconnected';
  elements.connectionStatus.classList.toggle('connected', connected);
}

async function loadSchema() {
  const result = await apiFetch('/api/schema');
  state.schema = result.config;
}

async function loadValues() {
  const result = await ipc({ cmd: 'list' });
  state.values = flattenValues(result);
  updateBenchmark(state.values.benchmark);
}

async function loadAssets() {
  const roots = Object.keys(state.schema?.files?.roots || {});
  await Promise.all(roots.map(async (root) => {
    const data = await apiFetch(`/api/files/${encodeURIComponent(root)}`);
    state.assets[root] = data.files || [];
  }));
}

function flattenValues(source, prefix = '', out = {}) {
  if (!source || typeof source !== 'object') return out;
  for (const [key, value] of Object.entries(source)) {
    if (key === 'ok') continue;
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
  if (!benchmark || typeof benchmark !== 'object') {
    elements.fpsStatus.textContent = 'FPS --';
    return;
  }
  const fps = benchmark.fps || benchmark.framesPerSecond || benchmark.averageFps;
  elements.fpsStatus.textContent = fps ? `FPS ${Number(fps).toFixed(1)}` : 'FPS --';
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

    if (stage.extras?.includes('refresh')) {
      const control = document.createElement('div');
      control.className = 'control';
      const button = document.createElement('button');
      button.className = 'action';
      button.textContent = 'Refresh State';
      button.addEventListener('click', refresh);
      control.appendChild(button);
      section.appendChild(control);
    }

    elements.stages.appendChild(section);
  }
}

function renderControl(key, rule) {
  if (rule.assetRoot) return renderAssetControl(key, rule);
  if (rule.type === 'boolean') return renderBooleanControl(key);
  if (rule.enum) return renderEnumControl(key, rule);
  if (rule.type === 'number' || rule.type === 'integer') return renderNumberControl(key, rule);
  if (key === 'background.overlayColor') return renderRgbControl(key);
  return renderTextControl(key, rule);
}

function controlShell(key, rangeText = '') {
  const control = document.createElement('div');
  control.className = 'control';
  const label = document.createElement('div');
  label.className = 'label';
  label.innerHTML = `<span>${LABELS[key] || key}</span><span>${rangeText}</span>`;
  control.appendChild(label);
  return control;
}

function renderBooleanControl(key) {
  const control = controlShell(key);
  const group = document.createElement('div');
  group.className = 'toggle';
  const value = Boolean(state.values[key]);
  const effective = BOOLEAN_INVERTED.has(key) ? !value : value;
  for (const option of [true, false]) {
    const button = document.createElement('button');
    button.textContent = option ? 'ON' : 'OFF';
    button.classList.toggle('active', effective === option);
    button.addEventListener('click', () => setValue(key, BOOLEAN_INVERTED.has(key) ? !option : option));
    group.appendChild(button);
  }
  control.appendChild(group);
  return control;
}

function renderEnumControl(key, rule) {
  const control = controlShell(key);
  const group = document.createElement('div');
  group.className = 'enum';
  for (const option of rule.enum) {
    const button = document.createElement('button');
    button.textContent = title(option);
    button.classList.toggle('active', state.values[key] === option);
    button.addEventListener('click', () => setValue(key, option));
    group.appendChild(button);
  }
  control.appendChild(group);
  return control;
}

function renderNumberControl(key, rule) {
  const min = rule.min ?? 0;
  const max = rule.max ?? 100;
  const step = rule.type === 'integer' ? 1 : 0.01;
  const value = Number(state.values[key] ?? min);
  const control = controlShell(key, `${min} bis ${max}`);
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

function renderRgbControl(key) {
  const value = String(state.values[key] || '0,255,0').split(',').map((part) => Number(part));
  const control = controlShell(key, '0 bis 255');
  const rgb = document.createElement('div');
  rgb.className = 'rgb';
  const preview = document.createElement('div');
  preview.className = 'color-preview';
  const inputs = [0, 1, 2].map((index) => {
    const input = document.createElement('input');
    input.type = 'number';
    input.min = 0;
    input.max = 255;
    input.step = 1;
    input.value = Number.isFinite(value[index]) ? value[index] : 0;
    input.addEventListener('change', () => {
      const next = inputs.map((item) => clamp(Number(item.value), 0, 255));
      preview.style.background = `rgb(${next.join(',')})`;
      setValue(key, next.join(','));
    });
    rgb.appendChild(input);
    return input;
  });
  preview.style.background = `rgb(${inputs.map((item) => item.value).join(',')})`;
  control.append(rgb, preview);
  return control;
}

function renderTextControl(key) {
  const control = controlShell(key);
  const input = document.createElement('input');
  input.type = 'text';
  input.value = state.values[key] || '';
  input.addEventListener('change', () => setValue(key, input.value));
  control.appendChild(input);
  return control;
}

function renderAssetControl(key, rule) {
  const control = controlShell(key);
  const root = rule.assetRoot;
  const row = document.createElement('div');
  row.className = 'asset-row';
  const select = document.createElement('select');
  const assets = state.assets[root] || [];
  const selectedAsset = assetIdFromValue(state.values[key]);
  select.appendChild(new Option('Select asset', ''));
  for (const asset of assets) {
    select.appendChild(new Option(`${asset.name} (${asset.type})`, asset.id));
  }
  select.value = selectedAsset;
  select.addEventListener('change', () => {
    if (select.value) setValue(key, select.value);
  });
  const deleteButton = document.createElement('button');
  deleteButton.className = 'action';
  deleteButton.textContent = 'Delete';
  deleteButton.disabled = !select.value;
  deleteButton.addEventListener('click', () => deleteAsset(root, select.value));
  row.append(select, deleteButton);

  const upload = document.createElement('div');
  upload.className = 'upload-row';
  const file = document.createElement('input');
  file.type = 'file';
  file.accept = '.zip,application/zip';
  const uploadButton = document.createElement('button');
  uploadButton.className = 'action';
  uploadButton.textContent = 'Upload ZIP';
  uploadButton.addEventListener('click', () => uploadAsset(root, file.files[0]));
  upload.append(file, uploadButton);
  control.append(row, upload);
  return control;
}

function assetIdFromValue(value) {
  if (!value || typeof value !== 'string') return '';
  return value.split('/')[0];
}

async function setValue(key, value) {
  try {
    await ipc({ cmd: 'set', key, value });
    state.values[key] = value;
    await refresh(false);
    showMessage(`${LABELS[key] || key} updated`);
  } catch (error) {
    showMessage(error.message, true);
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
    await loadAssets();
    await loadValues();
    render();
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

  function commit() {
    onCommit(Number(knob.dataset.value));
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
    startY = event.clientY;
    startValue = Number(knob.dataset.value);
    knob.setPointerCapture(event.pointerId);
  });

  knob.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    const delta = startY - event.clientY;
    setDisplay(startValue + (delta * ((max - min) / 160)));
  });

  knob.addEventListener('pointerup', (event) => {
    dragging = false;
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
  elements.settingsDialog.showModal();
});

elements.refreshButton.addEventListener('click', () => refresh());

elements.showTokenInput.addEventListener('change', () => {
  elements.tokenInput.type = elements.showTokenInput.checked ? 'text' : 'password';
});

elements.saveTokenButton.addEventListener('click', (event) => {
  event.preventDefault();
  state.token = elements.tokenInput.value.trim();
  localStorage.setItem(TOKEN_KEY, state.token);
  state.schema = null;
  elements.settingsDialog.close();
  refresh();
});

elements.clearTokenButton.addEventListener('click', (event) => {
  event.preventDefault();
  state.token = '';
  localStorage.removeItem(TOKEN_KEY);
  elements.tokenInput.value = '';
  state.schema = null;
  setConnected(false);
});

refresh(false);
