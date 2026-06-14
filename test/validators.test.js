import test from 'node:test';
import assert from 'node:assert/strict';
import { validateIpcRequest } from '../src/validators.js';

const config = {
  api: {
    commands: {
      list: { enabled: true },
      get: { enabled: true, keys: ['segmentation.threshold', 'benchmark'] },
      set: {
        enabled: true,
        items: {
          'segmentation.threshold': { type: 'number', min: 0, max: 1 },
          'background.blurStrength': { type: 'integer', min: 1, max: 100 },
          'background.effect': { type: 'string', enum: ['none', 'color', 'blur', 'image'] },
          'background.image': { type: 'string', pattern: '^[^/\\\\][^\\\\]*$', maxLength: 255 }
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
  assert.equal(validateIpcRequest({ cmd: 'set', key: 'background.effect', value: 'unsupported' }, config).ok, false);
});
