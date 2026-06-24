import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import os from 'node:os';
import yauzl from 'yauzl';
import { log } from './logger.js';

const ALLOWED_TYPES = new Set(['Image', 'Video', 'HTML App']);

export async function listFiles(rootName, config) {
  const root = rootConfig(rootName, config);
  if (root.kind === 'file') return listFlatFiles(rootName, root);
  log('info', 'Listing asset root', { rootName, rootPath: root.path });
  const entries = await fs.promises.readdir(root.path, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') {
      log('warn', 'Asset root does not exist; returning empty list', { rootName, rootPath: root.path });
      return [];
    }
    throw error;
  });
  const files = await Promise.all(entries
    .filter((entry) => entry.isDirectory())
    .map(async (entry) => {
      try {
        return await readAssetMetadata(rootName, entry.name, config, { publicView: true });
      } catch (error) {
        log('warn', 'Ignoring invalid asset directory while listing', {
          rootName,
          assetName: entry.name,
          rootPath: root.path,
          error: error.message
        });
        return null;
      }
    }));
  return files.filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
}

export async function uploadFile(req, rootName, fileName, config) {
  const root = rootConfig(rootName, config);
  if (!root.allowUpload) throw httpError(403, 'Uploads are disabled for this root.');
  if (root.kind === 'file') return uploadFlatFile(req, rootName, fileName, root, config);
  validateZipName(fileName);
  const contentLength = Number(req.headers['content-length'] ?? 0);
  if (!Number.isFinite(contentLength) || contentLength <= 0) throw httpError(411, 'Content-Length is required.');
  if (contentLength > config.files.maxUploadBytes) throw httpError(413, 'Upload exceeds maxUploadBytes.');

  await fs.promises.mkdir(root.path, { recursive: true });
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'jon-gateway-upload-'));
  const zipPath = path.join(tempDir, 'asset.zip');
  const extractDir = path.join(tempDir, 'extract');
  log('info', 'Asset upload started', {
    rootName,
    rootPath: root.path,
    fileName,
    contentLength,
    tempDir
  });

  let received = 0;
  req.on('data', (chunk) => {
    received += chunk.length;
    if (received > config.files.maxUploadBytes) req.destroy(httpError(413, 'Upload exceeds maxUploadBytes.'));
  });

  try {
    await pipeline(req, fs.createWriteStream(zipPath, { flags: 'w' }));
    const entries = await extractZip(zipPath, extractDir);
    const packageDirName = validateZipEntries(entries);
    const requestedAssetName = path.basename(fileName, '.zip');
    if (packageDirName !== requestedAssetName) {
      throw httpError(400, 'ZIP top-level directory must match the uploaded asset name.');
    }

    const extractedPackageDir = path.join(extractDir, packageDirName);
    const metadata = await readMetadataFile(path.join(extractedPackageDir, 'info.json'));
    validateAssetMetadata(metadata);
    await validateAssetStartFile(metadata.startFile, extractedPackageDir);

    const target = resolvePackageTarget(root, packageDirName);
    await fs.promises.rm(target, { recursive: true, force: true });
    await fs.promises.rename(extractedPackageDir, target);
    const publicMetadata = await readAssetMetadata(rootName, packageDirName, config, { publicView: true });
    log('info', 'Asset upload completed', {
      rootName,
      rootPath: root.path,
      assetName: packageDirName,
      target,
      type: publicMetadata.type,
      version: publicMetadata.version
    });
    return publicMetadata;
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
}

export async function deleteFile(rootName, assetName, config) {
  const root = rootConfig(rootName, config);
  if (!root.allowDelete) throw httpError(403, 'Deletes are disabled for this root.');
  if (root.kind === 'file') return deleteFlatFile(rootName, assetName, root);
  const target = resolvePackageTarget(root, assetName);
  log('warn', 'Deleting asset directory', { rootName, assetName, target });
  await fs.promises.rm(target, { recursive: true, force: false });
  return { deleted: path.basename(target) };
}

export async function downloadFile(rootName, assetName, config) {
  const root = rootConfig(rootName, config);
  if (root.kind !== 'file') throw httpError(405, 'Downloads are only available for file roots.');
  const fileName = flatFileNameFromAssetName(assetName, root);
  const target = resolveFlatFileTarget(root, fileName);
  const stat = await fs.promises.stat(target).catch((error) => {
    if (error.code === 'ENOENT') throw httpError(404, 'File not found.');
    throw error;
  });
  if (!stat.isFile()) throw httpError(404, 'File not found.');
  return {
    id: path.basename(fileName, path.extname(fileName)),
    fileName,
    filePath: target,
    contentType: contentTypeForExtension(path.extname(fileName)),
    size: stat.size,
    mtime: stat.mtime.toISOString()
  };
}

export async function resolveAssetStartFile(rootName, assetName, config) {
  const root = rootConfig(rootName, config);
  const packageDir = resolvePackageTarget(root, assetName);
  const metadata = await readMetadataFile(path.join(packageDir, 'info.json'));
  validateAssetMetadata(metadata);
  await validateAssetStartFile(metadata.startFile, packageDir);
  return `${assetName}/${metadata.startFile}`;
}

export async function readAssetMetadata(rootName, assetName, config, options = {}) {
  const root = rootConfig(rootName, config);
  const packageDir = resolvePackageTarget(root, assetName);
  const metadata = await readMetadataFile(path.join(packageDir, 'info.json'));
  validateAssetMetadata(metadata);
  const stat = await fs.promises.stat(packageDir);
  const result = {
    id: assetName,
    name: metadata.name,
    version: metadata.version,
    description: metadata.description,
    type: metadata.type,
    mtime: stat.mtime.toISOString()
  };
  if (!options.publicView) result.startFile = metadata.startFile;
  return result;
}

function rootConfig(rootName, config) {
  const root = config.files.roots[rootName];
  if (!root) throw httpError(404, `Unknown file root: ${rootName}`);
  return root;
}

async function listFlatFiles(rootName, root) {
  log('info', 'Listing file root', { rootName, rootPath: root.path });
  const entries = await fs.promises.readdir(root.path, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') {
      log('warn', 'File root does not exist; returning empty list', { rootName, rootPath: root.path });
      return [];
    }
    throw error;
  });
  const allowed = allowedExtensions(root);
  const files = await Promise.all(entries
    .filter((entry) => entry.isFile() && allowed.has(path.extname(entry.name).toLowerCase()))
    .map(async (entry) => {
      const fullPath = path.join(root.path, entry.name);
      const stat = await fs.promises.stat(fullPath);
      const id = path.basename(entry.name, path.extname(entry.name));
      return {
        id,
        name: id,
        version: '',
        description: entry.name,
        type: root.fileType || 'File',
        mtime: stat.mtime.toISOString()
      };
    }));
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

async function uploadFlatFile(req, rootName, fileName, root, config) {
  validateFlatFileName(fileName, root);
  const contentLength = Number(req.headers['content-length'] ?? 0);
  if (!Number.isFinite(contentLength) || contentLength <= 0) throw httpError(411, 'Content-Length is required.');
  if (contentLength > config.files.maxUploadBytes) throw httpError(413, 'Upload exceeds maxUploadBytes.');

  await fs.promises.mkdir(root.path, { recursive: true });
  const target = resolveFlatFileTarget(root, fileName);
  log('info', 'File upload started', { rootName, rootPath: root.path, fileName, contentLength, target });

  let received = 0;
  req.on('data', (chunk) => {
    received += chunk.length;
    if (received > config.files.maxUploadBytes) req.destroy(httpError(413, 'Upload exceeds maxUploadBytes.'));
  });

  await pipeline(req, fs.createWriteStream(target, { flags: 'w' }));
  const stat = await fs.promises.stat(target);
  const id = path.basename(fileName, path.extname(fileName));
  log('info', 'File upload completed', { rootName, rootPath: root.path, fileName, target });
  return {
    id,
    name: id,
    version: '',
    description: fileName,
    type: root.fileType || 'File',
    mtime: stat.mtime.toISOString()
  };
}

async function deleteFlatFile(rootName, assetName, root) {
  const target = resolveFlatFileTarget(root, flatFileNameFromAssetName(assetName, root));
  log('warn', 'Deleting file', { rootName, assetName, target });
  await fs.promises.rm(target, { force: false });
  return { deleted: path.basename(target, path.extname(target)) };
}

function resolveFlatFileTarget(root, fileName) {
  validateFlatFileName(fileName, root);
  const base = path.resolve(root.path);
  const target = path.resolve(base, fileName);
  if (!target.startsWith(`${base}${path.sep}`)) throw httpError(400, 'File path escapes the configured root.');
  return target;
}

function validateFlatFileName(fileName, root) {
  if (!fileName || fileName.includes('/') || fileName.includes('\\')) throw httpError(400, 'Invalid file name.');
  const extension = path.extname(fileName).toLowerCase();
  if (!allowedExtensions(root).has(extension)) {
    throw httpError(415, `Only ${[...allowedExtensions(root)].join(', ')} files are allowed.`);
  }
  validateAssetName(path.basename(fileName, extension));
}

function flatFileNameFromAssetName(assetName, root) {
  const extension = path.extname(assetName).toLowerCase();
  if (extension) {
    validateFlatFileName(assetName, root);
    return assetName;
  }
  validateAssetName(assetName);
  const [firstExtension] = [...allowedExtensions(root)];
  return `${assetName}${firstExtension}`;
}

function allowedExtensions(root) {
  return new Set((root.allowedExtensions || []).map((extension) => extension.toLowerCase()));
}

function contentTypeForExtension(extension) {
  if (extension.toLowerCase() === '.ttf') return 'font/ttf';
  return 'application/octet-stream';
}

function resolvePackageTarget(root, assetName) {
  validateAssetName(assetName);
  const base = path.resolve(root.path);
  const target = path.resolve(base, assetName);
  if (!target.startsWith(`${base}${path.sep}`)) throw httpError(400, 'File path escapes the configured root.');
  return target;
}

function validateZipName(fileName) {
  if (!fileName || path.extname(fileName).toLowerCase() !== '.zip') {
    throw httpError(415, 'Only .zip asset packages are allowed.');
  }
  validateAssetName(path.basename(fileName, '.zip'));
}

function validateAssetName(assetName) {
  if (!assetName || !/^[A-Za-z0-9._-]+$/.test(assetName) || assetName === '.' || assetName === '..') {
    throw httpError(400, 'Invalid asset name.');
  }
}

function validateZipEntries(entries) {
  if (entries.length === 0) throw httpError(400, 'ZIP package is empty.');
  const topDirs = new Set();
  for (const entry of entries) {
    validateZipEntryPath(entry);
    const [top] = entry.split('/');
    validateAssetName(top);
    topDirs.add(top);
  }
  if (topDirs.size !== 1) throw httpError(400, 'ZIP package must contain exactly one top-level directory.');
  const packageDirName = [...topDirs][0];
  if (!entries.includes(`${packageDirName}/info.json`)) {
    throw httpError(400, 'ZIP package must contain info.json in its top-level directory.');
  }
  return packageDirName;
}

function validateZipEntryPath(entry) {
  if (!entry || entry.includes('\0') || entry.startsWith('/') || entry.includes('\\')) {
    throw httpError(400, 'ZIP package contains an invalid path.');
  }
  const normalized = path.posix.normalize(entry);
  if (normalized.startsWith('../') || normalized === '..' || normalized !== entry) {
    throw httpError(400, 'ZIP package contains path traversal.');
  }
}

async function readMetadataFile(filePath) {
  let metadata;
  try {
    metadata = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
  } catch (error) {
    throw httpError(400, `Invalid or missing info.json: ${error.message}`);
  }
  if (metadata.startdatei && !metadata.startFile) metadata.startFile = metadata.startdatei;
  return metadata;
}

function validateAssetMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw httpError(400, 'info.json must be a JSON object.');
  }
  for (const key of ['name', 'version', 'description', 'type', 'startFile']) {
    if (typeof metadata[key] !== 'string' || metadata[key].trim() === '') {
      throw httpError(400, `info.json field must be a non-empty string: ${key}`);
    }
  }
  if (!ALLOWED_TYPES.has(metadata.type)) {
    throw httpError(400, 'info.json type must be one of: Image, Video, HTML App.');
  }
}

async function validateAssetStartFile(relativePath, packageDir) {
  if (relativePath.includes('\0') || path.isAbsolute(relativePath) || relativePath.includes('\\')) {
    throw httpError(400, 'info.json startFile must be a relative file path.');
  }
  const target = path.resolve(packageDir, relativePath);
  const base = path.resolve(packageDir);
  if (!target.startsWith(`${base}${path.sep}`)) {
    throw httpError(400, 'info.json startFile escapes the package directory.');
  }
  const stat = await fs.promises.stat(target).catch(() => null);
  if (!stat?.isFile()) {
    throw httpError(400, `info.json startFile does not exist as a file: ${relativePath}`);
  }
}

function extractZip(zipPath, extractDir) {
  return new Promise((resolve, reject) => {
    const entries = [];
    yauzl.open(zipPath, { lazyEntries: true, strictFileNames: true }, (openError, zipFile) => {
      if (openError) {
        reject(httpError(400, `Invalid ZIP package: ${openError.message}`));
        return;
      }

      zipFile.readEntry();
      zipFile.on('entry', async (entry) => {
        try {
          const fileName = entry.fileName.replace(/\/$/, '');
          if (fileName) entries.push(fileName);
          if (fileName) validateZipEntryPath(fileName);

          if (entry.fileName.endsWith('/')) {
            await fs.promises.mkdir(path.join(extractDir, entry.fileName), { recursive: true });
            zipFile.readEntry();
            return;
          }

          const target = path.resolve(extractDir, entry.fileName);
          const base = path.resolve(extractDir);
          if (!target.startsWith(`${base}${path.sep}`)) throw httpError(400, 'ZIP package contains path traversal.');
          await fs.promises.mkdir(path.dirname(target), { recursive: true });

          zipFile.openReadStream(entry, async (streamError, readStream) => {
            if (streamError) {
              reject(httpError(400, `Invalid ZIP entry: ${streamError.message}`));
              return;
            }
            try {
              await pipeline(readStream, fs.createWriteStream(target, { flags: 'w' }));
              zipFile.readEntry();
            } catch (writeError) {
              reject(writeError);
            }
          });
        } catch (error) {
          reject(error);
        }
      });
      zipFile.on('end', () => resolve(entries));
      zipFile.on('error', (error) => reject(httpError(400, `Invalid ZIP package: ${error.message}`)));
    });
  });
}

export function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
