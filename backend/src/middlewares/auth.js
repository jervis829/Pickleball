'use strict';
const crypto = require('node:crypto');
const { verifyToken } = require('../utils/crypto');
const { HttpError } = require('../utils/response');
const { users } = require('../repositories/misc');

function computePwdVer(u) {
  return crypto.createHash('sha256').update(String((u && u.password_hash) || '')).digest('hex').slice(0, 12);
}

function extractCookie(req, name) {
  const raw = req && req.headers && req.headers.cookie;
  if (!raw) return '';
  for (const part of String(raw).split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch (_) {
        return '';
      }
    }
  }
  return '';
}

function tokenCandidates(ctx) {
  const h = (ctx && ctx.req && ctx.req.headers) || {};
  const list = [];
  const sources = [];
  const ses = String(h['x-pkb-session'] || '').trim();
  if (ses) {
    list.push(ses.startsWith('Bearer ') ? ses.slice(7).trim() : ses);
    sources.push('x-pkb-session');
  }
  for (const key of ['x-pkb-auth', 'authorization']) {
    const val = String(h[key] || '');
    if (val.startsWith('Bearer ')) {
      list.push(val.slice(7).trim());
      sources.push(key);
    } else if (val) {
      sources.push(key + ':non-bearer');
    }
  }
  const ck = extractCookie(ctx && ctx.req, 'pkb_token');
  if (ck) { list.push(ck); sources.push('cookie'); }
  if (ctx) {
    ctx._authDiag = {
      sources,
      hdr_keys: Object.keys(h).sort(),
      xf_proto: h['x-forwarded-proto'] || null,
      matched: null
    };
  }
  return list.filter(Boolean);
}

function parseAuth(ctx) {
  ctx.user = null;
  const candidates = tokenCandidates(ctx);
  for (let i = 0; i < candidates.length; i++) {
    const u = verifyToken(candidates[i]);
    if (u && u.sub) {
      const dbUser = users.findById(u.sub);
      if (!dbUser || !dbUser.is_active) continue;
      if (u.pwd_ver && u.pwd_ver !== computePwdVer(dbUser)) continue;
      ctx.user = u;
      if (ctx._authDiag) ctx._authDiag.matched = ctx._authDiag.sources[i] || 'token';
      return;
    }
  }
  if (ctx && ctx._authDiag) {
    ctx._authDiag.matched = candidates.length ? 'invalid_or_expired' : 'none';
  }
}

function requireAuth(ctx) {
  if (!ctx.user) throw new HttpError(401, 'UNAUTHORIZED', '请先登录');
}

function requireWrite(ctx) {
  requireAuth(ctx);
  if (ctx.user.role === 'viewer') throw new HttpError(403, 'FORBIDDEN', '只读账号无写入权限');
}

module.exports = { parseAuth, requireAuth, requireWrite, tokenCandidates, computePwdVer };
