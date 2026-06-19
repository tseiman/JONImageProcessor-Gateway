import fs from 'node:fs';
import path from 'node:path';
import { sendIpcRequest } from './ipcClient.js';
import { httpError } from './fileStore.js';
import { log } from './logger.js';

const DEFAULT_PRESET_ID = 'default';
const CONFIG_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const OVERLAY_KEYS = new Set([
  'segmentation.threshold',
  'segmentation.smoothing',
  'segmentation.morphology',
  'background.effect',
  'background.image',
  'background.loopIfVideo',
  'background.overlayColor',
  'background.overlayAlpha',
  'background.blurStrength',
  'pause.enabled',
  'pause.image',
  'pause.loopIfVideo',
  'pause.showStatusText',
  'pause.textColor',
  'pause.textPosition',
  'pause.textSize',
  'pause.font',
  'pause.fontAlign',
  'diagnostics.benchmark'
]);

export async function listPresets(config) {
  const configDirectory = await readConfigDirectory(config);
  const entries = await fs.promises.readdir(configDirectory, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') {
      log('warn', 'Config directory does not exist; returning default preset only', { configDirectory });
      return [];
    }
    throw error;
  });

  const presets = await Promise.all(entries
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.json')
    .map(async (entry) => {
      const id = path.basename(entry.name, '.json');
      if (!isSafeConfigName(id)) return null;
      try {
        return await readPresetFile(configDirectory, id);
      } catch (error) {
        log('warn', 'Ignoring invalid overlay preset', { preset: id, configDirectory, error: error.message });
        return null;
      }
    }));

  return ensureDefaultPreset(presets.filter(Boolean)).sort(presetSort);
}

export async function readPreset(id, config) {
  const configDirectory = await readConfigDirectory(config);
  const safeId = validateConfigName(id);
  if (safeId === DEFAULT_PRESET_ID && !await fileExists(presetPath(configDirectory, safeId))) {
    return defaultPreset(false);
  }
  return await readPresetFile(configDirectory, safeId);
}

export async function savePreset(idOrName, values, config) {
  const configDirectory = await readConfigDirectory(config);
  const id = safeConfigName(idOrName);
  const overlay = isOverlayConfig(values) ? sanitizeOverlayConfig(values) : valuesToOverlayConfig(values);
  if (Object.keys(overlay).length === 0) throw httpError(400, 'Preset has no overlay-compatible settings.');

  await fs.promises.mkdir(configDirectory, { recursive: true });
  const target = presetPath(configDirectory, id);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fs.promises.writeFile(temp, `${JSON.stringify(overlay, null, 2)}\n`, { mode: 0o644 });
  await fs.promises.rename(temp, target);
  log('info', 'Saved overlay preset', { preset: id, configDirectory, target });
  return await readPresetFile(configDirectory, id);
}

export async function deletePreset(id, config) {
  const configDirectory = await readConfigDirectory(config);
  const safeId = validateConfigName(id);
  if (safeId === DEFAULT_PRESET_ID) throw httpError(403, 'Default preset cannot be deleted.');
  const target = presetPath(configDirectory, safeId);
  await fs.promises.rm(target, { force: false });
  log('warn', 'Deleted overlay preset', { preset: safeId, configDirectory, target });
  return { deleted: safeId };
}

export async function applyPreset(id, config) {
  const safeId = validateConfigName(id);
  const response = await sendIpcRequest({ cmd: 'set', key: 'config', value: safeId }, config);
  if (response.ok === false) throw httpError(502, response.error || 'JONImageProcessor rejected preset.');
  return response;
}

export function safeConfigName(value) {
  const ascii = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return validateConfigName(ascii || 'preset');
}

export function valuesToOverlayConfig(values = {}) {
  const overlay = {};
  for (const [key, value] of Object.entries(values)) {
    if (!OVERLAY_KEYS.has(key) || value === undefined) continue;
    const [section, item] = key.split('.');
    overlay[section] ??= {};
    overlay[section][item] = value;
  }
  return overlay;
}

export function sanitizeOverlayConfig(config = {}) {
  const overlay = {};
  for (const section of ['segmentation', 'background', 'pause', 'diagnostics']) {
    if (config[section] && typeof config[section] === 'object' && !Array.isArray(config[section])) {
      overlay[section] = { ...config[section] };
    }
  }
  return overlay;
}

export function overlayConfigToValues(overlay = {}) {
  const values = {};
  for (const key of OVERLAY_KEYS) {
    const [section, item] = key.split('.');
    if (overlay?.[section]?.[item] !== undefined) values[key] = overlay[section][item];
  }
  return values;
}

function isOverlayConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return ['segmentation', 'background', 'pause', 'diagnostics'].some((section) => value[section] && typeof value[section] === 'object');
}

async function readConfigDirectory(config) {
  const response = await sendIpcRequest({ cmd: 'get', key: 'system.configDirectory' }, config);
  if (response.ok === false || typeof response.value !== 'string' || response.value.trim() === '') {
    throw httpError(502, response.error || 'JONImageProcessor did not report system.configDirectory.');
  }
  return response.value;
}

async function readPresetFile(configDirectory, id) {
  const safeId = validateConfigName(id);
  const filePath = presetPath(configDirectory, safeId);
  const stat = await fs.promises.stat(filePath);
  const config = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
  return {
    id: safeId,
    name: presetName(safeId),
    locked: safeId === DEFAULT_PRESET_ID,
    exists: true,
    mtime: stat.mtime.toISOString(),
    values: overlayConfigToValues(config),
    config
  };
}

function ensureDefaultPreset(presets) {
  if (!presets.some((preset) => preset.id === DEFAULT_PRESET_ID)) presets.unshift(defaultPreset(false));
  return presets;
}

function defaultPreset(exists) {
  return {
    id: DEFAULT_PRESET_ID,
    name: 'Default',
    locked: true,
    exists,
    values: {},
    config: {}
  };
}

function presetName(id) {
  return id === DEFAULT_PRESET_ID ? 'Default' : id;
}

function presetSort(a, b) {
  if (a.id === DEFAULT_PRESET_ID) return -1;
  if (b.id === DEFAULT_PRESET_ID) return 1;
  return a.name.localeCompare(b.name);
}

function presetPath(configDirectory, id) {
  const safeId = validateConfigName(id);
  const base = path.resolve(configDirectory);
  const target = path.resolve(base, `${safeId}.json`);
  if (!target.startsWith(`${base}${path.sep}`)) throw httpError(400, 'Preset path escapes configDirectory.');
  return target;
}

function validateConfigName(id) {
  if (!isSafeConfigName(id)) throw httpError(400, 'Invalid preset name.');
  return id;
}

function isSafeConfigName(id) {
  return typeof id === 'string' && CONFIG_NAME_PATTERN.test(id) && id !== '.' && id !== '..';
}

async function fileExists(filePath) {
  return Boolean(await fs.promises.stat(filePath).catch(() => null));
}
