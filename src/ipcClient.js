import net from 'node:net';

export function sendIpcRequest(request, config) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(config.jonImageProcessor.ipcSocket);
    const timeoutMs = config.jonImageProcessor.requestTimeoutMs;
    let buffer = '';
    let settled = false;

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(result);
    };

    const timer = setTimeout(() => finish(new Error('JONImageProcessor IPC request timed out.')), timeoutMs);

    socket.on('connect', () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      const line = buffer.slice(0, newline).trim();
      try {
        finish(null, JSON.parse(line));
      } catch (error) {
        finish(new Error(`Invalid JSON response from JONImageProcessor: ${error.message}`));
      }
    });
    socket.on('error', (error) => finish(error));
    socket.on('end', () => {
      if (!settled) finish(new Error('JONImageProcessor IPC connection closed without a response.'));
    });
  });
}
