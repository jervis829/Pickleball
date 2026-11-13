'use strict';
process.env.DB_FILE = 'data/test-pickleball.db';
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASSWORD = 'test-password-123';
process.env.RATE_LIMIT_MAX = '10000';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const config = require('../src/config');
const { closeDb } = require('../src/db/connection');
const { migrate } = require('../src/db/migrate');
const { ensureAdmin } = require('../src/services/auth');
const { seed } = require('../../database/seeds/seed');
const { createServer } = require('../src/server');

let server, base, token;

before(async () => {
  for (const suffix of ['', '-wal', '-shm']) {
    const f = config.dbFile + suffix;
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
  migrate();
  ensureAdmin();
  seed({ skipMigrate: true, skipAdmin: true });
  server = createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise(r => server.close(r));
  closeDb();
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(config.dbFile + suffix); } catch (_) { /* 不存在 */ }
  }
});

async function api(path, opts = {}, useToken = true) {
  const headers = Object.assign({ 'content-type': 'application/json' }, opts.headers || {});
  if (token && useToken) headers.authorization = 'Bearer ' + token;
  const res = await fetch(base + path, Object.assign({}, opts, { headers }));
  let body = null;
  try { body = await res.json(); } catch (_) { /* 204 / HTML */ }
  return { status: res.status, body, headers: res.headers };
}

const snapshot = () => ({
  students: [
    { id: 'S001', name: '测试学员 · 陈一', age: 'adult', stage: 1, used: 6, total: 48, status: '在训', injury: '' },
    { id: 'S002', name: '测试学员 · 林二', age: 'senior', stage: 2, used: 24, total: 48, status: '待考', injury: '右肩既往不适' }
  ],
  plans: [{ id: 'P001', lesson: 7, stage: 1, tech: '网前 dink 与非截击区规则', minutes: 90, date: '2026-11-14', age: 'mixed', ageName: '混合班', studentIds: ['S001', 'S002'], text: '教案全文（测试）' }],
  sessions: [{ id: 'R001', studentId: 'S001', date: '2026-11-14', lesson: 6, minutes: 90, attend: '出勤', judge: '达标', rpe: 5, note: '分腿垫步时机改善；回中偏慢' }],
  assessments: [{ id: 'A001', studentId: 'S002', stage: 2, date: '2026-11-14', vals: { serve: 72 }, total: 68, conclusion: '未达晋级线 · 补考' }],
  thresholds: {}, defaults: { minutes: 90, renewWarn: 3 }, prefs: { theme: 'dark' }, demo: false
});

test('01 健康检查无需鉴权', async () => {
  const r = await api('/api/v1/health', {}, false);
  assert.equal(r.status, 200);
  assert.equal(r.body.data.status, 'ok');
});

test('02 未登录访问业务数据返回 401', async () => {
  const r = await api('/api/v1/state', {}, false);
  assert.equal(r.status, 401);
  assert.equal(r.body.error.code, 'UNAUTHORIZED');
});

test('03 错误密码返回 401', async () => {
  const r = await api('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'wrong' }) }, false);
  assert.equal(r.status, 401);
});

test('04 登录成功并返回 JWT', async () => {
  const r = await api('/api/v1/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'test-password-123' }) }, false);
  assert.equal(r.status, 200);
  assert.ok(r.body.data.token.split('.').length === 3);
  token = r.body.data.token;
  const me = await api('/api/v1/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.data.user.role, 'admin');
});

test('05 空库 state 结构完整、revision = 0', async () => {
  const r = await api('/api/v1/state');
  assert.equal(r.status, 200);
  assert.equal(r.body.data.revision, 0);
  assert.deepEqual(r.body.data.students, []);
  assert.equal(r.body.data.defaults.minutes, 90);
});

test('06 课程体系 24 单元 / 48 课次，三阶段齐全', async () => {
  const r = await api('/api/v1/curriculum');
  assert.equal(r.status, 200);
  assert.equal(r.body.data.units.length, 24);
  assert.equal(r.body.data.lesson_count, 48);
  assert.deepEqual([...new Set(r.body.data.units.map(u => u.s))].sort(), [1, 2, 3]);
});

test('07 全量同步写入数据库并可回读（含多学员关联）', async () => {
  const put = await api('/api/v1/state', { method: 'PUT', body: JSON.stringify({ state: snapshot(), revision: 0 }) });
  assert.equal(put.status, 200);
  assert.equal(put.body.data.revision, 1);

  const get = await api('/api/v1/state');
  assert.equal(get.body.data.students.length, 2);
  assert.equal(get.body.data.plans.length, 1);
  assert.deepEqual(get.body.data.plans[0].studentIds.sort(), ['S001', 'S002']);
  assert.equal(get.body.data.sessions[0].studentName, '测试学员 · 陈一');
  assert.equal(get.body.data.assessments[0].vals.serve, 72);
});

test('08 过期 revision 触发 409，不静默覆盖', async () => {
  const r = await api('/api/v1/state', { method: 'PUT', body: JSON.stringify({ state: snapshot(), revision: 0 }) });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'REVISION_CONFLICT');
});

test('09 细粒度 RESTful CRUD + 学员学习记录聚合', async () => {
  const created = await api('/api/v1/students', { method: 'POST', body: JSON.stringify({ id: 'S003', name: '细粒度学员', stage: 2, age: 'youth', used: 20 }) });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.name, '细粒度学员');

  const list = await api('/api/v1/students?page=1&pageSize=10&keyword=细粒度');
  assert.equal(list.status, 200);
  assert.equal(list.body.data.total, 1);

  const patched = await api('/api/v1/students/S003', { method: 'PATCH', body: JSON.stringify({ used: 21 }) });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.data.used, 21);

  const records = await api('/api/v1/students/S001/records');
  assert.equal(records.status, 200);
  assert.equal(records.body.data.progress.session_count, 1);
  assert.ok(records.body.data.timeline.length >= 2);
  assert.equal(records.body.data.safety.needs_assessment, false);
  const senior = await api('/api/v1/students/S002/records');
  assert.equal(senior.body.data.safety.needs_assessment, true, '伤病记录与常青年龄段须触发评估提示');
});

test('10 统计 KPI 每个指标都带定义与公式', async () => {
  const r = await api('/api/v1/stats');
  assert.equal(r.status, 200);
  assert.equal(r.body.data.values.students_total, 3);
  assert.equal(r.body.data.values.attendance_rate, 1);
  assert.equal(r.body.data.values.thresholds_calibrated, false);
  assert.equal(r.body.data.definitions.length, Object.keys(r.body.data.values).length);
  assert.ok(r.body.data.definitions.every(d => d.formula));
});

test('11 导出 / 导入备份闭环', async () => {
  const ex = await api('/api/v1/export');
  assert.equal(ex.status, 200);
  assert.equal(ex.body.data.format, 'pickleball-academy/backup');
  const im = await api('/api/v1/import', { method: 'POST', body: JSON.stringify(ex.body.data) });
  assert.equal(im.status, 200);
  const state = await api('/api/v1/state');
  assert.equal(state.body.data.students.length, 3);
});

test('12 输入校验失败返回 422，非法年龄段被拒绝', async () => {
  const r1 = await api('/api/v1/students', { method: 'POST', body: JSON.stringify({ name: '' }) });
  assert.equal(r1.status, 422);
  const r2 = await api('/api/v1/students', { method: 'POST', body: JSON.stringify({ name: 'X', age: 'unknown', stage: 9 }) });
  assert.equal(r2.status, 422);
  assert.ok(r2.body.error.details.length >= 2);
});

test('13 软删除：删除后不可见且返回 404', async () => {
  const del = await api('/api/v1/students/S003', { method: 'DELETE' });
  assert.equal(del.status, 204);
  const get = await api('/api/v1/students/S003');
  assert.equal(get.status, 404);
});

test('14 静态前端与 API.js 可访问，且带安全头', async () => {
  const page = await api('/', {}, false);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  const js = await api('/api.js', {}, false);
  assert.equal(js.status, 200);
  assert.ok(js.headers.get('content-type').includes('javascript'));
});

test('15 路径穿越被拒绝', async () => {
  const r = await api('/../.env', {}, false);
  assert.ok([403, 404].includes(r.status));
});

// ---- CORS：复现「来源不在白名单：https://ajtech.top」----
const proxyHeaders = (origin, host) => ({
  origin,
  host,
  'x-forwarded-host': host,
  'x-forwarded-proto': 'https'
});

test('16 HTTPS 反代下的同源 Origin 放行，恶意来源仍拒绝', async () => {
  const main = await api('/api/v1/health', { headers: proxyHeaders('https://ajtech.top', 'ajtech.top') }, false);
  assert.equal(main.status, 200, '经反代访问的本站点不得被判为跨域');
  assert.equal(main.headers.get('access-control-allow-origin'), 'https://ajtech.top');

  const www = await api('/api/v1/health', { headers: proxyHeaders('https://www.ajtech.top', 'www.ajtech.top') }, false);
  assert.equal(www.status, 200, 'www 子域同样自动同源');

  const evil = await api('/api/v1/health', { headers: proxyHeaders('https://evil.example', 'ajtech.top') }, false);
  assert.equal(evil.status, 403);
  assert.equal(evil.body.error.code, 'CORS_FORBIDDEN');
});

test('17 浏览器带 Origin 的登录不再被 CORS 拦截', async () => {
  const r = await api('/api/v1/auth/login', {
    method: 'POST',
    headers: proxyHeaders('https://ajtech.top', 'ajtech.top'),
    body: JSON.stringify({ username: 'admin', password: 'test-password-123' })
  }, false);
  assert.equal(r.status, 200);
  assert.ok(r.body.data.token);
});

test('18 OPTIONS 预检：同源 204、跨域 403', async () => {
  const ok = await api('/api/v1/state', { method: 'OPTIONS', headers: proxyHeaders('https://ajtech.top', 'ajtech.top') }, false);
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('access-control-allow-methods'), 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  const no = await api('/api/v1/state', { method: 'OPTIONS', headers: proxyHeaders('https://evil.example', 'ajtech.top') }, false);
  assert.equal(no.status, 403);
});

test('19 显式 CORS_ORIGINS 与同源来源取并集，不互相覆盖', async () => {
  const saved = config.corsOrigins;
  config.corsOrigins = ['https://partner.example'];
  try {
    const partner = await api('/api/v1/health', { headers: proxyHeaders('https://partner.example', 'ajtech.top') }, false);
    assert.equal(partner.status, 200);
    const self = await api('/api/v1/health', { headers: proxyHeaders('https://ajtech.top', 'ajtech.top') }, false);
    assert.equal(self.status, 200, '配置跨域白名单不应把本站同源请求挡掉');
  } finally {
    config.corsOrigins = saved;
  }
});
