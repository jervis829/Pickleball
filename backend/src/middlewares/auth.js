'use strict';
const { verifyToken } = require('../utils/crypto');
const { HttpError } = require('../utils/response');

function parseAuth(ctx) {
  const header = ctx.req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : (ctx.query.token || '');
  ctx.user = token ? verifyToken(token) : null;
}

function requireAuth(ctx) {
  if (!ctx.user) throw new HttpError(401, 'UNAUTHORIZED', '请先登录');
}

function requireWrite(ctx) {
  requireAuth(ctx);
  if (ctx.user.role === 'viewer') throw new HttpError(403, 'FORBIDDEN', '只读账号无写入权限');
}

module.exports = { parseAuth, requireAuth, requireWrite };
