import { createHash } from 'node:crypto';
import { extractToken, isAuthorized } from './auth.js';
import { sendIpcRequest } from './ipcClient.js';
import { validateIpcRequest } from './validators.js';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function handleUpgrade(req, socket, head, config) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== '/api/ws') {
    socket.destroy();
    return;
  }
  const token = extractToken(req, config, url);
  if (!isAuthorized(token, config)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  const key = req.headers['sec-websocket-key'];
  if (!key) {
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
  connection.onMessage = async (message) => {
    try {
      const body = JSON.parse(message);
      const validation = validateIpcRequest(body, config);
      if (!validation.ok) {
        connection.sendJson({ ok: false, error: validation.error });
        return;
      }
      const response = await sendIpcRequest(validation.request, config);
      connection.sendJson(response);
    } catch (error) {
      connection.sendJson({ ok: false, error: error.message });
    }
  };

  if (head?.length) connection.receive(head);
}

class WebSocketConnection {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.onMessage = () => {};
    socket.on('data', (chunk) => this.receive(chunk));
    socket.on('error', () => socket.destroy());
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
    this.sendFrame(Buffer.from(JSON.stringify(value), 'utf8'), 0x1);
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
