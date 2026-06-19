import test from 'node:test';
import assert from 'node:assert/strict';
import { overlayConfigToValues, safeConfigName, sanitizeOverlayConfig, valuesToOverlayConfig } from '../src/presetStore.js';

test('converts unsafe preset names to JONImageProcessor config names', () => {
  assert.equal(safeConfigName('Meeting Room 1'), 'Meeting-Room-1');
  assert.equal(safeConfigName('../Bad.Name'), 'Bad-Name');
  assert.equal(safeConfigName('Grün & Blau'), 'Grun-Blau');
});

test('converts flat WebUI values to grouped overlay config', () => {
  assert.deepEqual(valuesToOverlayConfig({
    'segmentation.threshold': 0.42,
    'background.effect': 'image',
    'background.image': 'office/index.html',
    'pause.textSize': 1.8,
    'camera.enabled': false,
    'system.version': 'ignored'
  }), {
    segmentation: { threshold: 0.42 },
    background: { effect: 'image', image: 'office/index.html' },
    pause: { textSize: 1.8 }
  });
});

test('extracts flat values from grouped overlay config', () => {
  assert.deepEqual(overlayConfigToValues({
    background: { effect: 'blur', blurStrength: 30 },
    pause: { fontAlign: 'center' },
    camera: { enabled: false }
  }), {
    'background.effect': 'blur',
    'background.blurStrength': 30,
    'pause.fontAlign': 'center'
  });
});

test('sanitizes imported full configs to overlay-compatible sections', () => {
  assert.deepEqual(sanitizeOverlayConfig({
    configDirectory: '/tmp',
    background: { effect: 'color' },
    pause: { enabled: true },
    display: { backend: 'drm' }
  }), {
    background: { effect: 'color' },
    pause: { enabled: true }
  });
});
