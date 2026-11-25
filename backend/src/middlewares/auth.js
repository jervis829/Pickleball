'use strict';
const { verifyToken } = require('../utils/crypto');
const { HttpError } = require('../utils/response');

function extractCookie(req, name) {
  const raw = req && req.headers && req.headers.cookie;
  if (!raw) return '';
  for (const part of String(raw).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return '';
}

function tokenCandidates(ctx) {
  const h = (ctx && ctx.req && ctx.req.headers) || {};
  const list = [];
  for (const key of ['x-pkb-auth', 'authorization']) {
    const val = String(h[key] || '');
    if (val.startsWith('Bearer ')) list.push(val.slice(7).trim());
  }
  const ck = extractCookie(ctx && ctx.req, 'pkb_token');
  if (ck) list.push(ck);
  if (ctx && ctx.query && ctx.query.token) list.push(String(ctx.query.token));
  return list.filter(Boolean);
}

function parseAuth(ctx) {
  ctx.user = null;
  for (const token of tokenCandidates(ctx)) {
    const u = verifyToken(token);
    if (u) { ctx.user = u; return; }
  }
}

function requireAuth(ctx) {
  if (!ctx.user) throw new HttpError(401, 'UNAUTHORIZED', '请先登录');
}

function requireWrite(ctx) {
  requireAuth(ctx);
  if (ctx.user.role === 'viewer') throw new HttpError(403, 'FORBIDDEN', '只读账号无写入权限');
}

module.exports = { parseAuth, requireAuth, requireWrite, tokenCandidates };
