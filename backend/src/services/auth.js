'use strict';
const config = require('../config');
const { users } = require('../repositories/misc');
const { verifyPassword, signToken } = require('../utils/crypto');
const { validate } = require('../utils/validate');
const { HttpError } = require('../utils/response');

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
  const u = users.findByUsername(v.username);
  if (!u || !u.is_active || !verifyPassword(v.password, u.salt, u.password_hash)) {
    throw new HttpError(401, 'INVALID_CREDENTIALS', '账号或密码错误');
  }
  return {
    token: signToken({ sub: u.id, username: u.username, role: u.role }),
    user: users.public(u),
    expires_in: config.jwtTtlSeconds
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
  return { changed: true, username: u.username };
}

const me = (ctx) => ({ user: { sub: ctx.user.sub, username: ctx.user.username, role: ctx.user.role }, exp: ctx.user.exp });

module.exports = { ensureAdmin, login, changePassword, me };
