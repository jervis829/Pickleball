'use strict';
const crypto = require('node:crypto');
const config = require('../config');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, SCRYPT).toString('hex');
  return { salt, password_hash: hash };
}

function verifyPassword(password, salt, expectedHex) {
  try {
    const actual = crypto.scryptSync(String(password), salt, SCRYPT.keylen, SCRYPT);
    const expected = Buffer.from(String(expectedHex), 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch (_) { return false; }
}

const b64u = (v) => Buffer.from(v).toString('base64url');

/** 轻量 JWT（HS256）：header.payload.signature，零依赖实现 */
function signToken(payload, ttlSeconds = config.jwtTtlSeconds) {
  const iat = Math.floor(Date.now() / 1000);
  const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ ...payload, iat, exp: iat + ttlSeconds }));
  const sig = crypto.createHmac('sha256', config.jwtSecret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

/**
 * 宽松校验：签名必须正确，但允许 exp 已过（最多过期 graceSeconds）。
 * 仅用于「续期」接口——签名不对一律拒绝，不会因为放宽时间就放行伪造令牌。
 */
function verifyTokenAllowExpired(token, graceSeconds = 0) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const expected = crypto.createHmac('sha256', config.jwtSecret)
    .update(`${parts[0]}.${parts[1]}`).digest('base64url');
  const a = Buffer.from(parts[2]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    if (!payload.exp || payload.exp + Math.max(0, Number(graceSeconds) || 0) < now) return null;
    return payload;
  } catch (_) { return null; }
}

function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const expected = crypto.createHmac('sha256', config.jwtSecret)
    .update(`${parts[0]}.${parts[1]}`).digest('base64url');
  const a = Buffer.from(parts[2]);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (_) { return null; }
}

const newId = (prefix = '') => prefix + crypto.randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase();

module.exports = { hashPassword, verifyPassword, signToken, verifyToken, verifyTokenAllowExpired, newId };
