'use strict';
const crypto = require('node:crypto');
const config = require('../config');
const { users } = require('../repositories/misc');
const { verifyPassword, signToken, verifyTokenAllowExpired } = require('../utils/crypto');
const { validate } = require('../utils/validate');
const { HttpError } = require('../utils/response');

const pwdVer = (u) => crypto.createHash('sha256').update(String((u && u.password_hash) || '')).digest('hex').slice(0, 12);

// 登录防爆破窗口：同账号 5 分钟内连续失败 >= 10 次触发限流
const LOGIN_FAIL_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_FAIL_MAX = 10;
const loginFailures = new Map();

function checkLoginRateLimit(username) {
  const key = String(username || '').toLowerCase();
  const now = Date.now();
  if (loginFailures.size > 500) {
    for (const [k, v] of loginFailures.entries()) {
      if (now - v.firstAt > LOGIN_FAIL_WINDOW_MS) loginFailures.delete(k);
    }
  }
  const rec = loginFailures.get(key);
  if (rec && now - rec.firstAt <= LOGIN_FAIL_WINDOW_MS && rec.count >= LOGIN_FAIL_MAX) {
    throw new HttpError(429, 'RATE_LIMITED', '连续登录失败次数过多，请 5 分钟后再试');
  }
}

function recordLoginFailure(username) {
  const key = String(username || '').toLowerCase();
  const now = Date.now();
  const rec = loginFailures.get(key);
  if (!rec || now - rec.firstAt > LOGIN_FAIL_WINDOW_MS) {
    loginFailures.set(key, { count: 1, firstAt: now });
  } else {
    rec.count += 1;
  }
}

function clearLoginFailure(username) {
  loginFailures.delete(String(username || '').toLowerCase());
}

/** 首次启动建管理员；返回 null 表示已存在 */
function ensureAdmin() {
  if (users.count() === 0) return users.createAdmin();
  return null;
}

function login(body) {
  const v = validate(body, {
    username: { type: 'string', required: true, maxLength: 80 },
    password: { type: 'string', required: true, maxLength: 200 }
  });
  checkLoginRateLimit(v.username);
  const u = users.findByUsername(v.username);
  if (!u || !u.is_active || !verifyPassword(v.password, u.salt, u.password_hash)) {
    recordLoginFailure(v.username);
    throw new HttpError(401, 'INVALID_CREDENTIALS', '账号或密码错误');
  }
  clearLoginFailure(v.username);
  return {
    token: signToken({ sub: u.id, username: u.username, role: u.role, pwd_ver: pwdVer(u) }),
    user: users.public(u),
    expires_in: config.jwtTtlSeconds,
    refresh_grace: config.jwtRefreshGraceSeconds
  };
}

function changePassword(ctx, body) {
  const v = validate(body, {
    old_password: { type: 'string', required: true, maxLength: 200 },
    new_password: { type: 'string', required: true, maxLength: 200 }
  });
  if (v.new_password.length < 10) {
    throw new HttpError(422, 'VALIDATION_ERROR', '新密码至少 10 位', [{ field: 'new_password', message: '长度不足' }]);
  }
  const u = users.findById(ctx.user.sub);
  if (!u || !verifyPassword(v.old_password, u.salt, u.password_hash)) {
    throw new HttpError(401, 'INVALID_CREDENTIALS', '原密码不正确');
  }
  users.updatePassword(u.id, v.new_password);
  clearLoginFailure(u.username);
  return { changed: true, username: u.username };
}

/**
 * 静默续期：用当前令牌换一张新令牌（不要求重新输密码）。
 * - 签名必须有效；过期时间最多放宽 jwtRefreshGraceSeconds（默认 1 小时），
 *   所以合盖休眠后回来还能续上，但超过宽限期仍必须重新登录。
 * - 账号被停用 / 删除或改密后拒绝续期。
 * - 前端在页面可见、请求成功、以及「快到期的前 30 分钟」自动调用。
 */
function refresh(ctx) {
  const { tokenCandidates } = require('../middlewares/auth');
  let payload = null;
  for (const raw of tokenCandidates(ctx)) {
    const p = verifyTokenAllowExpired(raw, config.jwtRefreshGraceSeconds);
    if (p) { payload = p; break; }
  }
  if (!payload) throw new HttpError(401, 'REFRESH_EXPIRED', '登录已过期，请重新输入密码');
  const u = users.findById(payload.sub);
  if (!u || !u.is_active) throw new HttpError(401, 'ACCOUNT_DISABLED', '账号不可用，请重新登录');
  if (payload.pwd_ver && payload.pwd_ver !== pwdVer(u)) {
    throw new HttpError(401, 'TOKEN_REVOKED', '密码已变更，请重新登录');
  }
  return {
    token: signToken({ sub: u.id, username: u.username, role: u.role, pwd_ver: pwdVer(u) }),
    user: users.public(u),
    expires_in: config.jwtTtlSeconds,
    refreshed: true
  };
}

const me = (ctx) => ({ user: { sub: ctx.user.sub, username: ctx.user.username, role: ctx.user.role }, exp: ctx.user.exp });

module.exports = { ensureAdmin, login, changePassword, refresh, me, _clearLoginFailures: () => loginFailures.clear() };
