'use strict';
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const C = require('../controllers');
const { fail } = require('../utils/response');
const { requireAuth, requireWrite } = require('../middlewares/auth');
const { audit } = require('../repositories/misc');

const routes = [];
function add(method, url, handler, opts = {}) {
  const keys = [];
  const pattern = url.replace(/:([A-Za-z0-9_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; });
  routes.push({
    method,
    re: new RegExp('^' + pattern + '$'),
    keys,
    handler,
    auth: opts.auth !== false,
    write: opts.write !== undefined ? opts.write : ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)
  });
}

/* ---------- 系统与认证 ---------- */
add('GET', '/api/v1/health', C.health, { auth: false });
add('POST', '/api/v1/auth/login', C.login, { auth: false, write: false });
add('GET', '/api/v1/auth/me', C.me);
add('POST', '/api/v1/auth/change-password', C.changePassword);
add('POST', '/api/v1/auth/logout', C.logout, { write: false });

/* ---------- 聚合 state / 备份 / 统计 / 课程体系 ---------- */
add('GET', '/api/v1/state', C.stateGet);
add('PUT', '/api/v1/state', C.statePut);
add('GET', '/api/v1/export', C.exportAll);
add('POST', '/api/v1/import', C.importAll);
add('GET', '/api/v1/stats', C.stats);
add('GET', '/api/v1/curriculum', C.curriculum);
add('GET', '/api/v1/students/:id/records', C.studentRecords);
add('GET', '/api/v1/students/:id/skill-progress', C.studentSkillProgress);
add('GET', '/api/v1/curriculum/:lesson/skill-points', C.lessonSkillPoints);
add('GET', '/api/v1/plans/:id/skill-points', C.planSkillPoints);
add('GET', '/api/v1/sessions/:id/skill-scores', C.sessionSkillScores);
add('PUT', '/api/v1/sessions/:id/skill-scores', C.saveSessionSkillScores);

/* ---------- 各实体 RESTful CRUD ---------- */
for (const [name, h] of Object.entries({
  students: C.students, plans: C.plans, sessions: C.sessions, assessments: C.assessments
})) {
  add('GET', `/api/v1/${name}`, h.list);
  add('POST', `/api/v1/${name}`, h.create);
  add('GET', `/api/v1/${name}/:id`, h.get);
  add('PATCH', `/api/v1/${name}/:id`, h.update);
  add('DELETE', `/api/v1/${name}/:id`, h.remove);
}

/* ---------- 静态前端 ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png', '.woff2': 'font/woff2'
};

function serveStatic(ctx) {
  if (ctx.req.method !== 'GET' && ctx.req.method !== 'HEAD') return false;
  const rel = ctx.path === '/' ? '/index.html' : ctx.path;
  const file = path.resolve(config.frontendDir, '.' + rel);
  // 路径穿越防护
  if (!file.startsWith(config.frontendDir + path.sep)) {
    fail(ctx.res, 403, 'FORBIDDEN', '禁止访问该路径'); return true;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  ctx.res.setHeader('content-type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
  if (ctx.req.method === 'HEAD') { ctx.res.writeHead(200); ctx.res.end(); return true; }
  const stream = fs.createReadStream(file);
  stream.on('error', () => { if (!ctx.res.headersSent) fail(ctx.res, 500, 'IO_ERROR', '读取文件失败'); });
  stream.pipe(ctx.res);
  return true;
}

async function dispatch(ctx) {
  for (const r of routes) {
    if (r.method !== ctx.req.method) continue;
    const m = r.re.exec(ctx.path);
    if (!m) continue;
    ctx.params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    if (r.auth) requireAuth(ctx);
    if (r.write) requireWrite(ctx);
    await r.handler(ctx);
    if (r.write && ctx.res.statusCode < 400) audit.write(ctx, r.method + ' ' + ctx.path);
    return;
  }
  if (serveStatic(ctx)) return;
  fail(ctx.res, 404, 'NOT_FOUND', '接口或页面不存在：' + ctx.path);
}

module.exports = { dispatch, routes };
