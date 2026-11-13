'use strict';

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.details = details || [];
  }
}

const now = () => new Date().toISOString();

function send(res, status, payload, extraHeaders = {}) {
  if (res.writableEnded) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    ...extraHeaders
  });
  res.end(body);
}

const ok = (res, data, status = 200, message) =>
  send(res, status, { success: true, data, message: message || 'OK', timestamp: now() });
const created = (res, data) => ok(res, data, 201, 'Created');
const noContent = (res) => { res.writeHead(204); res.end(); };
const fail = (res, status, code, message, details) =>
  send(res, status, {
    success: false,
    error: { code, message, details: details || [] },
    timestamp: now()
  });

module.exports = { HttpError, send, ok, created, noContent, fail, now };
