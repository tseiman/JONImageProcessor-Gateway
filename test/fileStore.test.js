import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { deleteFile, listFiles, resolveAssetStartFile } from '../src/fileStore.js';

async function withTempRoot(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'jon-gateway-test-'));
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
        backgrounds: {
          path: root,
          allowUpload: true,
          allowDelete: true,
          allowedExtensions: ['.zip'],
          ipcKey: 'background.image'
        }
      }
    }
  };
}

function fontConfigFor(root) {
  return {
    files: {
      roots: {
        fonts: {
          path: root,
          kind: 'file',
          fileType: 'TTF Font',
          allowUpload: true,
          allowDelete: true,
          allowedExtensions: ['.ttf']
        }
      }
    }
  };
}

test('lists asset metadata without exposing package file names', async () => {
  await withTempRoot(async (root) => {
    await fs.mkdir(path.join(root, 'studio-loop'));
    await fs.writeFile(path.join(root, 'studio-loop', 'loop.mp4'), 'video');
    await fs.writeFile(path.join(root, 'studio-loop', 'info.json'), JSON.stringify({
      name: 'Studio Loop',
      version: '1.0.0',
      description: 'Looping studio background',
      type: 'Video',
      startFile: 'loop.mp4'
    }));

    const assets = await listFiles('backgrounds', configFor(root));
    assert.deepEqual(assets, [{
      id: 'studio-loop',
      name: 'Studio Loop',
      version: '1.0.0',
      description: 'Looping studio background',
      type: 'Video',
      mtime: assets[0].mtime
    }]);
  });
});

test('resolves an asset name to the relative JONImageProcessor start file', async () => {
  await withTempRoot(async (root) => {
    await fs.mkdir(path.join(root, 'app-bg'));
    await fs.writeFile(path.join(root, 'app-bg', 'index.html'), '<!doctype html>');
    await fs.writeFile(path.join(root, 'app-bg', 'info.json'), JSON.stringify({
      name: 'App Background',
      version: '2.1.0',
      description: 'HTML app background',
      type: 'HTML App',
      startdatei: 'index.html'
    }));

    const resolved = await resolveAssetStartFile('backgrounds', 'app-bg', configFor(root));
    assert.equal(resolved, 'app-bg/index.html');
  });
});

test('lists TTF files as font ids without exposing paths', async () => {
  await withTempRoot(async (root) => {
    await fs.writeFile(path.join(root, 'Inter.ttf'), 'font');
    await fs.writeFile(path.join(root, 'ignored.otf'), 'font');

    const fonts = await listFiles('fonts', fontConfigFor(root));
    assert.deepEqual(fonts, [{
      id: 'Inter',
      name: 'Inter',
      version: '',
      description: 'Inter.ttf',
      type: 'TTF Font',
      mtime: fonts[0].mtime
    }]);
  });
});

test('deletes TTF files by font id', async () => {
  await withTempRoot(async (root) => {
    await fs.writeFile(path.join(root, 'Inter.ttf'), 'font');

    const result = await deleteFile('fonts', 'Inter', fontConfigFor(root));
    assert.deepEqual(result, { deleted: 'Inter' });
    await assert.rejects(fs.stat(path.join(root, 'Inter.ttf')));
  });
});
