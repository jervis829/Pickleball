'use strict';

// 敏感字段绝不写入日志
const REDACT = new Set([
  'password', 'password_hash', 'admin_password', 'jwt_secret', 'secret',
  'token', 'authorization', 'x-pkb-auth', 'cookie', 'new_password', 'old_password'
]);

function scrub(value, depth = 0) {
  if (depth > 4 || value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(v => scrub(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = REDACT.has(k.toLowerCase()) ? '[REDACTED]' : scrub(v, depth + 1);
    }
    return out;
  }
  return value;
}

function emit(level, msg, meta = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...scrub(meta) });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

module.exports = {
  info: (msg, meta) => emit('info', msg, meta),
  warn: (msg, meta) => emit('warn', msg, meta),
  error: (msg, meta) => emit('error', msg, meta),
  request: (ctx, status, ms) => emit('info', 'http.request', {
    request_id: ctx.requestId,
    method: ctx.req.method,
    path: ctx.path,
    status,
    duration_ms: ms,
    actor: ctx.user ? ctx.user.sub : 'anonymous'
  })
};
