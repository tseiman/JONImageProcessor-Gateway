import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { prepareIpcRequest } from '../src/ipcGateway.js';

async function withTempRoot(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jon-gateway-ipc-test-'));
  try {
    await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function configFor(root) {
  return {
    files: {
      roots: {
        backgrounds: { path: root }
      }
    },
    api: {
      commands: {
        list: { enabled: true },
        get: { enabled: true, keys: [] },
        set: {
          enabled: true,
          items: {
            'background.image': {
              type: 'string',
              pattern: '^[A-Za-z0-9._-]+$',
              maxLength: 120,
              assetRoot: 'backgrounds'
            }
          }
        }
      }
    }
  };
}

test('maps background asset ids to package start files before IPC forwarding', async () => {
  await withTempRoot(async (root) => {
    await fs.mkdir(path.join(root, 'studio-background'));
    await fs.writeFile(path.join(root, 'studio-background', 'background.jpg'), 'image');
    await fs.writeFile(path.join(root, 'studio-background', 'info.json'), JSON.stringify({
      name: 'Studio Background',
      version: '1.0.0',
      description: 'A packaged background',
      type: 'Image',
      startFile: 'background.jpg'
    }));

    const prepared = await prepareIpcRequest({
      cmd: 'set',
      key: 'background.image',
      value: 'studio-background'
    }, configFor(root));

    assert.deepEqual(prepared, {
      ok: true,
      request: {
        cmd: 'set',
        key: 'background.image',
        value: 'studio-background/background.jpg'
      }
    });
  });
});
