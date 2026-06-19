import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import { loadConfig, publicConfig } from './config.js';
import { extractToken, isAuthorized } from './auth.js';
import { sendIpcRequest } from './ipcClient.js';
import { deleteFile, httpError, listFiles, uploadFile } from './fileStore.js';
import { handleUpgrade, setMutationPollRequester } from './websocket.js';
import { prepareIpcRequest } from './ipcGateway.js';
import { errorFields, log } from './logger.js';
import { startStatePolling } from './statePoller.js';
import { applyPreset, deletePreset, listPresets, readPreset, renamePreset, savePreset } from './presetStore.js';

const config = loadConfig();
const PUBLIC_DIR = path.resolve(process.cwd(), 'public');
let nextRequestId = 1;
const statePoller = startStatePolling(config);
setMutationPollRequester(statePoller.requestPoll);

const server = http.createServer(async (req, res) => {
  const requestId = nextRequestId++;
  const started = process.hrtime.bigint();
  const url = new URL(req.url, `http://${req.headers.host}`);
  log('info', 'HTTP request started', requestLogFields(req, url, requestId));
  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    log(level, 'HTTP request completed', {
      ...requestLogFields(req, url, requestId),
      status: res.statusCode,
      durationMs: Math.round(durationMs * 1000) / 1000
    });
  });

  try {
    if (req.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      writeCorsHeaders(req, res);
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/health') {
      await writeJson(req, res, 200, { ok: true, service: 'jonimageprocessor-gateway' });
      return;
    }

    if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
      const served = await serveStatic(url.pathname, res);
      if (served) return;
    }

    const token = extractToken(req, config, url);
    if (!isAuthorized(token, config)) {
      log('warn', 'Unauthorized request rejected', requestLogFields(req, url, requestId));
      await writeJson(req, res, 401, { ok: false, error: 'Unauthorized.' });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/schema') {
      await writeJson(req, res, 200, { ok: true, config: publicConfig(config) });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/ipc') {
      const body = await readJson(req);
      const prepared = await prepareIpcRequest(body, config);
      if (!prepared.ok) {
        log('warn', 'IPC request rejected by gateway validation', {
          ...requestLogFields(req, url, requestId),
          ipcCommand: body?.cmd,
          ipcKey: body?.key,
          validationError: prepared.error
        });
        await writeJson(req, res, 400, { ok: false, error: prepared.error });
        return;
      }
      log('info', 'Forwarding IPC request', {
        ...requestLogFields(req, url, requestId),
        ipcCommand: prepared.request.cmd,
        ipcKey: prepared.request.key
      });
      const response = await sendIpcRequest(prepared.request, config);
      if (response.ok === false) {
        log('warn', 'JONImageProcessor IPC returned an error', {
          ...requestLogFields(req, url, requestId),
          ipcCommand: prepared.request.cmd,
          ipcKey: prepared.request.key,
          ipcError: response.error
        });
      }
      if (prepared.request.cmd === 'set') statePoller.requestPoll('http-set');
      await writeJson(req, res, response.ok === false ? 502 : 200, response);
      return;
    }

    const presetMatch = url.pathname.match(/^\/api\/presets(?:\/([^/]+)(?:\/(apply|rename))?)?$/);
    if (presetMatch) {
      const presetId = presetMatch[1] ? decodeURIComponent(presetMatch[1]) : '';
      const action = presetMatch[2] || '';
      if (req.method === 'GET' && !presetId) {
        await writeJson(req, res, 200, { ok: true, presets: await listPresets(config) });
        return;
      }
      if (req.method === 'GET' && presetId && !action) {
        await writeJson(req, res, 200, { ok: true, preset: await readPreset(presetId, config) });
        return;
      }
      if ((req.method === 'PUT' || req.method === 'POST') && presetId && !action) {
        const body = await readJson(req);
        await writeJson(req, res, 200, {
          ok: true,
          preset: await savePreset(presetId, body.values || body.config || body, config, { name: body.name })
        });
        return;
      }
      if (req.method === 'POST' && presetId && action === 'rename') {
        const body = await readJson(req);
        await writeJson(req, res, 200, { ok: true, preset: await renamePreset(presetId, body.name, config) });
        return;
      }
      if (req.method === 'POST' && presetId && action === 'apply') {
        const response = await applyPreset(presetId, config);
        statePoller.requestPoll('http-preset');
        await writeJson(req, res, 200, { ok: true, response });
        return;
      }
      if (req.method === 'DELETE' && presetId && !action) {
        await writeJson(req, res, 200, { ok: true, preset: await deletePreset(presetId, config) });
        return;
      }
      await writeJson(req, res, 405, { ok: false, error: 'Method not allowed for preset.' });
      return;
    }

    const fileMatch = url.pathname.match(/^\/api\/files\/([^/]+)(?:\/(.+))?$/);
    if (fileMatch) {
      const root = decodeURIComponent(fileMatch[1]);
      const fileName = fileMatch[2] ? decodeURIComponent(fileMatch[2]) : '';
      if (req.method === 'GET' && !fileName) {
        await writeJson(req, res, 200, { ok: true, files: await listFiles(root, config) });
        return;
      }
      if ((req.method === 'PUT' || req.method === 'POST') && fileName) {
        await writeJson(req, res, 201, { ok: true, file: await uploadFile(req, root, fileName, config) });
        return;
      }
      if (req.method === 'DELETE' && fileName) {
        await writeJson(req, res, 200, { ok: true, file: await deleteFile(root, fileName, config) });
        return;
      }
      await writeJson(req, res, 405, {
        ok: false,
        error: fileName
          ? 'Method not allowed for asset. Use PUT or POST to upload, DELETE to delete.'
          : 'Method not allowed for asset list. Use GET.'
      });
      return;
    }

    await writeJson(req, res, 404, { ok: false, error: 'Not found.' });
  } catch (error) {
    const status = error.status ?? 500;
    log(status >= 500 ? 'error' : 'warn', 'HTTP request failed', {
      ...requestLogFields(req, url, requestId),
      ...errorFields(error)
    });
    await writeJson(req, res, status, { ok: false, error: error.message });
  }
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  log('info', 'WebSocket upgrade requested', {
    method: req.method,
    path: url.pathname,
    remoteAddress: remoteAddress(req)
  });
  handleUpgrade(req, socket, head, config);
});

server.on('error', (error) => {
  log('error', 'HTTP server error', errorFields(error));
});

server.listen(config.server.port, config.server.host, () => {
  log('info', 'JONImageProcessor Gateway listening', {
    host: config.server.host,
    port: config.server.port,
    configPath: config.__path,
    ipcSocket: config.jonImageProcessor.ipcSocket
  });
});

process.on('uncaughtException', (error) => {
  log('error', 'Uncaught exception', errorFields(error));
  process.exitCode = 1;
});

process.on('unhandledRejection', (reason) => {
  const error = reason instanceof Error ? reason : new Error(String(reason));
  log('error', 'Unhandled promise rejection', errorFields(error));
});

async function readJson(req) {
  const contentType = req.headers['content-type'] ?? '';
  if (!contentType.includes('application/json')) throw httpError(415, 'Content-Type must be application/json.');
  let body = '';
  for await (const chunk of req) {
    body += chunk.toString('utf8');
    if (body.length > 1024 * 1024) throw httpError(413, 'JSON body is too large.');
  }
  try {
    return JSON.parse(body);
  } catch (error) {
    throw httpError(400, `Invalid JSON: ${error.message}`);
  }
}

function writeJson(req, res, status, value) {
  const body = JSON.stringify(value);
  writeCorsHeaders(req, res);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  res.end(body);
}

function writeCorsHeaders(req, res) {
  const origin = req.headers.origin;
  const allowed = config.server.corsAllowedOrigins ?? [];
  if (!origin || allowed.length === 0) return;
  if (allowed.includes('*') || allowed.includes(origin)) {
    res.setHeader('access-control-allow-origin', allowed.includes('*') ? '*' : origin);
    res.setHeader('access-control-allow-methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('access-control-allow-headers', 'authorization,x-api-token,content-type');
    res.setHeader('access-control-max-age', '600');
  }
}

function requestLogFields(req, url, requestId) {
  return {
    requestId,
    method: req.method,
    path: url.pathname,
    remoteAddress: remoteAddress(req),
    userAgent: req.headers['user-agent'],
    contentLength: req.headers['content-length']
  };
}

function remoteAddress(req) {
  return req.socket?.remoteAddress || req.connection?.remoteAddress || null;
}

async function serveStatic(requestPath, res) {
  const pathname = requestPath === '/' ? '/index.html' : requestPath;
  const decoded = decodeURIComponent(pathname);
  if (decoded.includes('\0')) throw httpError(400, 'Invalid static path.');
  const target = path.resolve(PUBLIC_DIR, `.${decoded}`);
  if (!target.startsWith(`${PUBLIC_DIR}${path.sep}`)) throw httpError(400, 'Invalid static path.');

  const stat = await fs.promises.stat(target).catch(() => null);
  if (!stat?.isFile()) return false;

  const body = await fs.promises.readFile(target);
  res.writeHead(200, {
    'content-type': contentType(target),
    'content-length': body.length,
    'cache-control': target.endsWith('index.html') ? 'no-store' : 'public, max-age=3600'
  });
  res.end(body);
  return true;
}

function contentType(filePath) {
  switch (path.extname(filePath).toLowerCase()) {
    case '.html': return 'text/html; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.js': return 'text/javascript; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.ico': return 'image/x-icon';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    default: return 'application/octet-stream';
  }
}
