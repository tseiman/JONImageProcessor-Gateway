import { sendIpcRequest } from './ipcClient.js';
import { resolveAssetStartFile } from './fileStore.js';
import { validateIpcRequest } from './validators.js';

export async function prepareIpcRequest(body, config) {
  const validation = validateIpcRequest(body, config);
  if (!validation.ok) return validation;

  const request = { ...validation.request };
  if (request.cmd === 'set') {
    const rule = config.api?.commands?.set?.items?.[request.key];
    if (rule?.assetRoot) {
      request.value = await resolveAssetStartFile(rule.assetRoot, request.value, config);
    }
  }
  return { ok: true, request };
}

export async function handleIpcRequest(body, config) {
  const prepared = await prepareIpcRequest(body, config);
  if (!prepared.ok) return prepared;
  return await sendIpcRequest(prepared.request, config);
}
