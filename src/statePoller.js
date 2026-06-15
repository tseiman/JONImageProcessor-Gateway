import { sendIpcRequest } from './ipcClient.js';
import { broadcastJson, websocketClientCount } from './websocket.js';
import { errorFields, log } from './logger.js';

export function startStatePolling(config) {
  let inFlight = false;
  let settleTimer = null;
  const intervalMs = config.jonImageProcessor.pollIntervalMs;

  async function poll(reason = 'interval') {
    if (inFlight) return;
    if (websocketClientCount() === 0 && reason === 'interval') return;
    inFlight = true;
    try {
      const response = await sendIpcRequest({ cmd: 'list' }, config);
      if (response.ok === false) {
        log('warn', 'State poll returned IPC error', { reason, ipcError: response.error });
        broadcastJson({ type: 'state-error', reason, error: response.error, time: new Date().toISOString() });
      } else {
        broadcastJson({ type: 'state', reason, state: response, time: new Date().toISOString() });
      }
    } catch (error) {
      log('warn', 'State poll failed', { reason, ...errorFields(error) });
      broadcastJson({ type: 'state-error', reason, error: error.message, time: new Date().toISOString() });
    } finally {
      inFlight = false;
    }
  }

  const timer = setInterval(() => {
    poll('interval');
  }, intervalMs);
  timer.unref?.();

  function requestPoll(reason = 'requested') {
    poll(reason);
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => poll(`${reason}-settle`), Math.min(500, Math.max(150, intervalMs / 2)));
    settleTimer.unref?.();
  }

  requestPoll('startup');
  return { requestPoll };
}
