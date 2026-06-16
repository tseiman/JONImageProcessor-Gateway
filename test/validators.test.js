import test from 'node:test';
import assert from 'node:assert/strict';
import { validateIpcRequest } from '../src/validators.js';

const config = {
  api: {
    commands: {
      list: { enabled: true },
      get: { enabled: true, keys: ['segmentation.threshold', 'benchmark', 'pause.fontDirectory'] },
      set: {
        enabled: true,
        items: {
          'segmentation.threshold': { type: 'number', min: 0, max: 1 },
          'background.blurStrength': { type: 'integer', min: 1, max: 100 },
          'background.effect': { type: 'string', enum: ['none', 'color', 'blur', 'image'] },
          'background.image': { type: 'string', pattern: '^[A-Za-z0-9._-]+$', maxLength: 120, assetRoot: 'backgrounds' },
          'pause.font': { type: 'string', pattern: '^[A-Za-z0-9._-]+$', maxLength: 120 },
          'pause.fontAlign': { type: 'string', enum: ['left', 'center', 'right'] }
        }
      }
    }
  }
};

test('allows configured get and set IPC requests', () => {
  assert.deepEqual(validateIpcRequest({ cmd: 'get', key: 'benchmark' }, config), {
    ok: true,
    request: { cmd: 'get', key: 'benchmark' }
  });
  assert.deepEqual(validateIpcRequest({ cmd: 'set', key: 'segmentation.threshold', value: 0.75 }, config), {
    ok: true,
    request: { cmd: 'set', key: 'segmentation.threshold', value: 0.75 }
  });
});

test('rejects out-of-range and unknown IPC writes', () => {
  assert.equal(validateIpcRequest({ cmd: 'set', key: 'segmentation.threshold', value: 1.2 }, config).ok, false);
  assert.equal(validateIpcRequest({ cmd: 'set', key: 'benchmark', value: true }, config).ok, false);
});

test('rejects invalid string values for media keys', () => {
  assert.equal(validateIpcRequest({ cmd: 'set', key: 'background.image', value: '../secret.jpg' }, config).ok, false);
  assert.equal(validateIpcRequest({ cmd: 'set', key: 'background.image', value: 'asset/file.jpg' }, config).ok, false);
  assert.equal(validateIpcRequest({ cmd: 'set', key: 'background.effect', value: 'unsupported' }, config).ok, false);
});

test('allows safe TTF font base names and font alignment values', () => {
  assert.deepEqual(validateIpcRequest({ cmd: 'get', key: 'pause.fontDirectory' }, config), {
    ok: true,
    request: { cmd: 'get', key: 'pause.fontDirectory' }
  });
  assert.deepEqual(validateIpcRequest({ cmd: 'set', key: 'pause.font', value: 'Inter-Regular' }, config), {
    ok: true,
    request: { cmd: 'set', key: 'pause.font', value: 'Inter-Regular' }
  });
  assert.deepEqual(validateIpcRequest({ cmd: 'set', key: 'pause.fontAlign', value: 'center' }, config), {
    ok: true,
    request: { cmd: 'set', key: 'pause.fontAlign', value: 'center' }
  });
});

test('rejects unsafe TTF font names and invalid font alignment values', () => {
  assert.equal(validateIpcRequest({ cmd: 'set', key: 'pause.font', value: '../Inter' }, config).ok, false);
  assert.equal(validateIpcRequest({ cmd: 'set', key: 'pause.font', value: 'Inter/Regular' }, config).ok, false);
  assert.equal(validateIpcRequest({ cmd: 'set', key: 'pause.fontAlign', value: 'justify' }, config).ok, false);
});
