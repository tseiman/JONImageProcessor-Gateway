import http from 'node:http';
import { URL } from 'node:url';
import { loadConfig, publicConfig } from './config.js';
import { extractToken, isAuthorized } from './auth.js';
import { sendIpcRequest } from './ipcClient.js';
import { validateIpcRequest } from './validators.js';
import { deleteFile, httpError, listFiles, uploadFile } from './fileStore.js';
import { handleUpgrade } from './websocket.js';

const config = loadConfig();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
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

    const token = extractToken(req, config, url);
    if (!isAuthorized(token, config)) {
      await writeJson(req, res, 401, { ok: false, error: 'Unauthorized.' });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/schema') {
      await writeJson(req, res, 200, { ok: true, config: publicConfig(config) });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/ipc') {
      const body = await readJson(req);
      const validation = validateIpcRequest(body, config);
      if (!validation.ok) {
        await writeJson(req, res, 400, { ok: false, error: validation.error });
        return;
      }
      const response = await sendIpcRequest(validation.request, config);
      await writeJson(req, res, response.ok === false ? 502 : 200, response);
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
      if (req.method === 'PUT' && fileName) {
        await writeJson(req, res, 201, { ok: true, file: await uploadFile(req, root, fileName, config) });
        return;
      }
      if (req.method === 'DELETE' && fileName) {
        await writeJson(req, res, 200, { ok: true, file: await deleteFile(root, fileName, config) });
        return;
      }
    }

    await writeJson(req, res, 404, { ok: false, error: 'Not found.' });
  } catch (error) {
    const status = error.status ?? 500;
    await writeJson(req, res, status, { ok: false, error: error.message });
  }
});

server.on('upgrade', (req, socket, head) => handleUpgrade(req, socket, head, config));

server.listen(config.server.port, config.server.host, () => {
  console.log(`JONImageProcessor Gateway listening on http://${config.server.host}:${config.server.port}`);
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
