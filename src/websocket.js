import { createHash } from 'node:crypto';
import { extractToken, isAuthorized } from './auth.js';
import { handleIpcRequest } from './ipcGateway.js';
import { errorFields, log } from './logger.js';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const connections = new Set();
let mutationPollRequester = () => {};

export function setMutationPollRequester(fn) {
  mutationPollRequester = fn;
}

export function websocketClientCount() {
  return connections.size;
}

export function broadcastJson(value) {
  for (const connection of connections) {
    connection.sendJson(value);
  }
}

export function handleUpgrade(req, socket, head, config) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== '/api/ws') {
    log('warn', 'Rejected WebSocket upgrade for unknown path', { path: url.pathname });
    socket.destroy();
    return;
  }
  const token = extractToken(req, config, url);
  if (!isAuthorized(token, config)) {
    log('warn', 'Rejected unauthorized WebSocket upgrade', {
      path: url.pathname,
      remoteAddress: req.socket.remoteAddress
    });
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  const key = req.headers['sec-websocket-key'];
  if (!key) {
    log('warn', 'Rejected WebSocket upgrade without Sec-WebSocket-Key', { path: url.pathname });
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  const accept = createHash('sha1').update(`${key}${WS_GUID}`).digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '\r\n'
  ].join('\r\n'));

  const connection = new WebSocketConnection(socket);
  connections.add(connection);
  connection.onClose = () => {
    connections.delete(connection);
    log('info', 'WebSocket client disconnected', { clients: connections.size });
  };
  log('info', 'WebSocket client connected', { clients: connections.size });
  connection.sendJson({ type: 'hello', clients: connections.size, time: new Date().toISOString() });
  mutationPollRequester('websocket-connect');

  connection.onMessage = async (message) => {
    try {
      const body = JSON.parse(message);
      log('info', 'WebSocket IPC request received', {
        ipcCommand: body?.cmd,
        ipcKey: body?.key
      });
      const response = await handleIpcRequest(body, config);
      if (response.ok === false) {
        log('warn', 'WebSocket IPC request failed', {
          ipcCommand: body?.cmd,
          ipcKey: body?.key,
          ipcError: response.error
        });
      }
      connection.sendJson({ type: 'ipc-response', request: { cmd: body?.cmd, key: body?.key }, response });
      if (body?.cmd === 'set') mutationPollRequester('websocket-set');
    } catch (error) {
      log('warn', 'WebSocket message handling failed', errorFields(error));
      connection.sendJson({ type: 'error', ok: false, error: error.message });
    }
  };

  if (head?.length) connection.receive(head);
}

class WebSocketConnection {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.closed = false;
    this.onMessage = () => {};
    this.onClose = () => {};
    socket.on('data', (chunk) => this.receive(chunk));
    socket.on('error', () => socket.destroy());
    socket.on('close', () => this.handleClose());
    socket.on('end', () => this.handleClose());
  }

  handleClose() {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
  }

  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        this.close(1009);
        return;
      }
      if (!masked) {
        this.close(1002);
        return;
      }
      if (this.buffer.length < offset + 4 + length) return;
      const mask = this.buffer.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }
      this.buffer = this.buffer.subarray(offset + length);

      if (opcode === 0x8) {
        this.close();
        return;
      }
      if (opcode === 0x9) {
        this.sendFrame(payload, 0xA);
        continue;
      }
      if (opcode === 0x1) this.onMessage(payload.toString('utf8'));
    }
  }

  sendJson(value) {
    try {
      this.sendFrame(Buffer.from(JSON.stringify(value), 'utf8'), 0x1);
    } catch {
      this.socket.destroy();
    }
  }

  sendFrame(payload, opcode) {
    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, length]);
    } else if (length <= 65535) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      throw new Error('WebSocket response is too large.');
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  close(code = 1000) {
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    this.sendFrame(payload, 0x8);
    this.socket.end();
  }
}
