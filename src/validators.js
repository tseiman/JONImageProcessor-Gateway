export function validateIpcRequest(request, config) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return fail('Request body must be a JSON object.');
  }

  const { cmd, key, value } = request;
  const commands = config.api?.commands ?? {};
  if (cmd !== 'get' && cmd !== 'set' && cmd !== 'list') {
    return fail('Unsupported IPC command.');
  }
  if (!commands[cmd]?.enabled) {
    return fail(`IPC command is disabled: ${cmd}`);
  }

  if (cmd === 'list') return { ok: true, request: { cmd } };

  if (typeof key !== 'string' || key.length === 0) {
    return fail('IPC key must be a non-empty string.');
  }

  if (cmd === 'get') {
    const allowedKeys = commands.get.keys ?? [];
    if (!allowedKeys.includes(key)) return fail(`IPC get key is not allowed: ${key}`);
    return { ok: true, request: { cmd, key } };
  }

  const rule = commands.set.items?.[key];
  if (!rule) return fail(`IPC set key is not allowed: ${key}`);
  const valueResult = validateValue(value, rule);
  if (!valueResult.ok) return valueResult;
  return { ok: true, request: { cmd, key, value } };
}

function validateValue(value, rule) {
  switch (rule.type) {
    case 'boolean':
      if (typeof value !== 'boolean') return fail('Value must be boolean.');
      break;
    case 'string':
      if (typeof value !== 'string') return fail('Value must be string.');
      if (rule.maxLength && value.length > rule.maxLength) return fail(`Value is longer than ${rule.maxLength} characters.`);
      if (rule.enum && !rule.enum.includes(value)) return fail(`Value must be one of: ${rule.enum.join(', ')}`);
      if (rule.pattern && !(new RegExp(rule.pattern).test(value))) return fail('Value does not match the required pattern.');
      if (value.includes('..')) return fail('Value must not contain path traversal.');
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return fail('Value must be number.');
      if (rule.min !== undefined && value < rule.min) return fail(`Value must be >= ${rule.min}.`);
      if (rule.max !== undefined && value > rule.max) return fail(`Value must be <= ${rule.max}.`);
      break;
    case 'integer':
      if (!Number.isInteger(value)) return fail('Value must be integer.');
      if (rule.min !== undefined && value < rule.min) return fail(`Value must be >= ${rule.min}.`);
      if (rule.max !== undefined && value > rule.max) return fail(`Value must be <= ${rule.max}.`);
      break;
    default:
      return fail(`Unsupported validator type: ${rule.type}`);
  }
  return { ok: true };
}

function fail(error) {
  return { ok: false, error };
}
