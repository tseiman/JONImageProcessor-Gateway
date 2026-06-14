const PRIORITY = {
  error: 3,
  warn: 4,
  info: 6,
  debug: 7
};

export function log(level, message, fields = {}) {
  const priority = PRIORITY[level] ?? PRIORITY.info;
  const record = {
    time: new Date().toISOString(),
    level,
    message,
    ...fields
  };
  const line = `<${priority}>${JSON.stringify(record)}`;
  if (level === 'error' || level === 'warn') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export function errorFields(error) {
  return {
    error: error.message,
    code: error.code,
    status: error.status,
    stack: error.stack
  };
}
