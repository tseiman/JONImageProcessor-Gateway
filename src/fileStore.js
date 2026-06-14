import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

export async function listFiles(rootName, config) {
  const root = rootConfig(rootName, config);
  const entries = await fs.promises.readdir(root.path, { withFileTypes: true });
  const files = await Promise.all(entries
    .filter((entry) => entry.isFile())
    .map(async (entry) => {
      const fullPath = path.join(root.path, entry.name);
      const stat = await fs.promises.stat(fullPath);
      return { name: entry.name, size: stat.size, mtime: stat.mtime.toISOString() };
    }));
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

export async function uploadFile(req, rootName, fileName, config) {
  const root = rootConfig(rootName, config);
  if (!root.allowUpload) throw httpError(403, 'Uploads are disabled for this root.');
  const target = resolveTarget(root, fileName);
  validateExtension(target, root);
  const contentLength = Number(req.headers['content-length'] ?? 0);
  if (!Number.isFinite(contentLength) || contentLength <= 0) throw httpError(411, 'Content-Length is required.');
  if (contentLength > config.files.maxUploadBytes) throw httpError(413, 'Upload exceeds maxUploadBytes.');

  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  let received = 0;
  req.on('data', (chunk) => {
    received += chunk.length;
    if (received > config.files.maxUploadBytes) req.destroy(httpError(413, 'Upload exceeds maxUploadBytes.'));
  });
  await pipeline(req, fs.createWriteStream(target, { flags: 'w' }));
  const stat = await fs.promises.stat(target);
  return { name: path.basename(target), size: stat.size, mtime: stat.mtime.toISOString() };
}

export async function deleteFile(rootName, fileName, config) {
  const root = rootConfig(rootName, config);
  if (!root.allowDelete) throw httpError(403, 'Deletes are disabled for this root.');
  const target = resolveTarget(root, fileName);
  validateExtension(target, root);
  await fs.promises.unlink(target);
  return { deleted: path.basename(target) };
}

function rootConfig(rootName, config) {
  const root = config.files.roots[rootName];
  if (!root) throw httpError(404, `Unknown file root: ${rootName}`);
  return root;
}

function resolveTarget(root, fileName) {
  if (!fileName || fileName.includes('\0') || path.isAbsolute(fileName) || fileName.includes('..')) {
    throw httpError(400, 'Invalid file name.');
  }
  const base = path.resolve(root.path);
  const target = path.resolve(base, fileName);
  if (!target.startsWith(`${base}${path.sep}`)) throw httpError(400, 'File path escapes the configured root.');
  return target;
}

function validateExtension(target, root) {
  const allowed = root.allowedExtensions ?? [];
  if (allowed.length === 0) return;
  const ext = path.extname(target).toLowerCase();
  if (!allowed.map((item) => item.toLowerCase()).includes(ext)) {
    throw httpError(415, `File extension is not allowed: ${ext}`);
  }
}

export function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}
