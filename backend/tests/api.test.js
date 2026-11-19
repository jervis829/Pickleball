'use strict';
process.env.DB_FILE = 'data/test-pickleball.db';
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASSWORD = 'test-password-123';
process.env.RATE_LIMIT_MAX = '10000';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const config = require('../src/config');
const { closeDb, all } = require('../src/db/connection');
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

/**
 * 用「指定令牌」发请求。
 * 注意不能用 api()：它会把全局 token 覆盖到 authorization 头上，
 * 导致「过期令牌应被拒绝」这类断言永远拿不到 401。
 */
async function apiAs(path, token, opts = {}) {
  const headers = Object.assign({ 'content-type': 'application/json' }, opts.headers || {});
  if (token) headers.authorization = 'Bearer ' + token;
  const res = await fetch(base + path, Object.assign({}, opts, { headers }));
  let body = null;
  try { body = await res.json(); } catch (_) { /* 204 */ }
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
  const mapped = all('SELECT COUNT(DISTINCT lesson_no) AS lessons, COUNT(*) AS points FROM lesson_skill_points')[0];
  assert.equal(mapped.lessons, 48, '评分项目应覆盖全部48课次');
  assert.ok(mapped.points >= 48, '每课至少应有一个评分判据');
  const sample = all("SELECT lesson_no, lesson_type, criterion FROM lesson_skill_points WHERE lesson_no IN (1,2) ORDER BY lesson_no, sort_order");
  assert.ok(sample.some(x => x.lesson_no === 1 && x.lesson_type === 'A'));
  assert.ok(sample.some(x => x.lesson_no === 2 && x.lesson_type === 'B'));
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

test('20 v4.1 训练参数与双维评分字段可持久化', async () => {
  const cur = await api('/api/v1/state');
  const snap = snapshot();
  snap.params = { feedBalls: 24, strengthSets: 4, jointReps: 10 };
  snap.students[0].techScore = 3;
  snap.students[0].fitScore = 5;
  snap.students[0].pkLevel = 0;
  snap.students[0].racketBase = 5;
  snap.students[0].goal = '兴趣体验';
  const put = await api('/api/v1/state', {
    method: 'PUT', body: JSON.stringify({ state: snap, revision: cur.body.data.revision })
  });
  assert.equal(put.status, 200);
  const get = await api('/api/v1/state');
  assert.equal(get.body.data.params.feedBalls, 24);
  assert.equal(get.body.data.params.strengthSets, 4);
  const s1 = get.body.data.students.find(x => x.id === 'S001');
  assert.equal(s1.techScore, 3, '网球职业转项：技术 3 分');
  assert.equal(s1.fitScore, 5, '其他项目职业运动员：体能 5 分');
  assert.equal(s1.pkLevel, 0);
  assert.equal(s1.racketBase, 5);
  assert.equal(s1.goal, '兴趣体验');
});

test('21 v4.1 课程体系含手法层技术点 flick / roll', async () => {
  const r = await api('/api/v1/curriculum');
  assert.equal(r.status, 200);
  const text = JSON.stringify(r.body.data.units);
  assert.equal(r.body.data.units.length, 24);
  assert.ok(/flick/.test(text), 'U14 应含 flick');
  assert.ok(/roll volley/.test(text), 'U14 应含 roll volley');
  assert.ok(/roll dink/.test(text), 'U13 应含 roll dink');
  assert.ok(/hands battle/.test(text), 'U19 应含 hands battle');
  assert.ok(!/教学管理中台/.test(text));
});


test('22 教案评分快照、课后0–5分录入与学员技术成长查询', async () => {
  const lessonPoints = await api('/api/v1/curriculum/1/skill-points');
  assert.equal(lessonPoints.status, 200);
  assert.ok(lessonPoints.body.data.items.length > 0);

  const plan = await api('/api/v1/plans', {
    method: 'POST',
    body: JSON.stringify({ id: 'PSKILL01', lesson: 1, stage: 1, tech: '评分接口测试', minutes: 90, studentIds: ['S001'], text: '测试教案' })
  });
  assert.equal(plan.status, 201);
  const frozen = await api('/api/v1/plans/PSKILL01/skill-points');
  assert.equal(frozen.status, 200);
  assert.ok(frozen.body.data.items.length > 0);
  assert.ok(frozen.body.data.items[0].rubricSnapshot);

  const session = await api('/api/v1/sessions', {
    method: 'POST',
    body: JSON.stringify({ id: 'RSKILL01', studentId: 'S001', planId: 'PSKILL01', lesson: 1, date: '2026-11-18', minutes: 90, attend: '出勤' })
  });
  assert.equal(session.status, 201);

  const item = frozen.body.data.items[0];
  const saved = await api('/api/v1/sessions/RSKILL01/skill-scores', {
    method: 'PUT',
    body: JSON.stringify({ scores: [{ planSkillPointId: item.id, score: 3, attempts: 10, successes: 7, coachNote: '标准练习下基本达到' }] })
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.data.items.find(x => x.id === item.id).score, 3);

  const progress = await api('/api/v1/students/S001/skill-progress');
  assert.equal(progress.status, 200);
  assert.equal(progress.body.data.totalScores, 1);
  assert.equal(progress.body.data.skills[0].latestScore, 3);

  const invalid = await api('/api/v1/sessions/RSKILL01/skill-scores', {
    method: 'PUT',
    body: JSON.stringify({ scores: [{ planSkillPointId: item.id, score: 6 }] })
  });
  assert.equal(invalid.status, 422);

  // 连续两次低于3分应标记薄弱；近期高RPE触发负荷保护。
  for (const [n, score, rpe] of [[2, 2, 8], [3, 1, 9]]) {
    const planId = 'PSKILL0' + n, sessionId = 'RSKILL0' + n;
    const p = await api('/api/v1/plans', {
      method: 'POST',
      body: JSON.stringify({ id: planId, lesson: 1, stage: 1, tech: '动态推荐测试', minutes: 90, studentIds: ['S001'], text: '测试' })
    });
    assert.equal(p.status, 201);
    const snap = await api('/api/v1/plans/' + planId + '/skill-points');
    const ss = await api('/api/v1/sessions', {
      method: 'POST',
      body: JSON.stringify({ id: sessionId, studentId: 'S001', planId, lesson: 1, date: '2026-11-18', minutes: 90, rpe, attend: '出勤' })
    });
    assert.equal(ss.status, 201);
    const point = snap.body.data.items.find(x => x.skillKey === item.skillKey);
    const scoreRes = await api('/api/v1/sessions/' + sessionId + '/skill-scores', {
      method: 'PUT',
      body: JSON.stringify({ scores: [{ planSkillPointId: point.id, score }] })
    });
    assert.equal(scoreRes.status, 200);
  }
  const rec = await api('/api/v1/students/S001/training-recommendations?lesson=1');
  assert.equal(rec.status, 200);
  assert.ok(rec.body.data.weakSkills.some(x => x.skillKey === item.skillKey));
  assert.ok(rec.body.data.matchedWeakSkills.some(x => x.skillKey === item.skillKey));
  assert.equal(rec.body.data.safety.holdAdditionalLoad, true);

  // 连续三次达到4分及以上，状态转为稳定掌握。
  for (const n of [4, 5, 6]) {
    const planId = 'PSKILL0' + n, sessionId = 'RSKILL0' + n;
    await api('/api/v1/plans', { method: 'POST', body: JSON.stringify({ id: planId, lesson: 1, stage: 1, tech: '稳定掌握测试', minutes: 90, studentIds: ['S001'], text: '测试' }) });
    const snap = await api('/api/v1/plans/' + planId + '/skill-points');
    await api('/api/v1/sessions', { method: 'POST', body: JSON.stringify({ id: sessionId, studentId: 'S001', planId, lesson: 1, date: '2026-11-18', minutes: 90, rpe: 5, attend: '出勤' }) });
    const point = snap.body.data.items.find(x => x.skillKey === item.skillKey);
    await api('/api/v1/sessions/' + sessionId + '/skill-scores', { method: 'PUT', body: JSON.stringify({ scores: [{ planSkillPointId: point.id, score: 4 }] }) });
  }
  const mastered = await api('/api/v1/students/S001/training-recommendations?lesson=1');
  assert.equal(mastered.status, 200);
  assert.ok(mastered.body.data.masteredSkills.some(x => x.skillKey === item.skillKey));
  assert.ok(!mastered.body.data.weakSkills.some(x => x.skillKey === item.skillKey));
});


test('23 P5-B：三阶段评估协议以草案状态提供，且没有自动晋级线', async () => {
  const list = await api('/api/v1/assessment-protocols');
  assert.equal(list.status, 200);
  assert.equal(list.body.data.length, 3);
  assert.ok(list.body.data.every(p => p.status === 'draft' && p.calibrationStatus === 'coach_pilot_required'));
  const s1 = list.body.data.find(p => p.stage === 1);
  assert.ok(s1.criteria.some(c => c.code === 'third_shot_drop'));
  assert.ok(s1.criteria.some(c => c.code === 'nvz_dink'));
  assert.ok(s1.criteria.every(c => c.passRule.rule.includes('待教练试测') || c.passRule.rule.includes('关键能力项')));
  const blocked = await api('/api/v1/assessment-attempts', {
    method: 'POST', body: JSON.stringify({ studentId: 'S001', protocolId: 'missing-protocol' })
  });
  assert.equal(blocked.status, 404);
});

test('24 P5-B：评估记录固化协议快照、保存单项证据并保留未评估状态', async () => {
  const created = await api('/api/v1/assessment-attempts', {
    method: 'POST',
    body: JSON.stringify({ id: 'AT-P5B-01', studentId: 'S001', protocolId: 'AP-STAGE1-V1', assessmentDate: '2026-11-18', lessonNumber: 16, assessorName: '测试教练' })
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.status, 'in_progress');
  assert.equal(created.body.data.conclusion, null);
  assert.equal(created.body.data.protocolSnapshot.version, 1);
  const criterion = created.body.data.protocolSnapshot.criteria.find(x => x.code === 'third_shot_drop');
  const saved = await api('/api/v1/assessment-attempts/AT-P5B-01/results', {
    method: 'PUT',
    body: JSON.stringify({ results: [{ criterionId: criterion.id, score: 3, achieved: null, rawTrials: [{ attempt: 1, outcome: '观察记录' }], observations: '记录动作弧线与落点' }] })
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.data.conclusion, null, '草案协议不得产生晋级结论');
  assert.equal(saved.body.data.results[0].score, 3);
  assert.equal(saved.body.data.results[0].achieved, null);
  assert.equal(saved.body.data.results[0].rawTrials.length, 1);
  const invalid = await api('/api/v1/assessment-attempts/AT-P5B-01/results', {
    method: 'PUT', body: JSON.stringify({ results: [{ criterionId: criterion.id, score: 5 }] })
  });
  assert.equal(invalid.status, 422, '阶段评估量表范围为0–4');
});

test('25 P5-B：复测必须关联同一学员与同一协议，旧 assessments 仍保留', async () => {
  const wrongStudent = await api('/api/v1/assessment-attempts', {
    method: 'POST', body: JSON.stringify({ studentId: 'S002', protocolId: 'AP-STAGE1-V1', retestOfId: 'AT-P5B-01' })
  });
  assert.equal(wrongStudent.status, 422);
  const retest = await api('/api/v1/assessment-attempts', {
    method: 'POST', body: JSON.stringify({ studentId: 'S001', protocolId: 'AP-STAGE1-V1', retestOfId: 'AT-P5B-01' })
  });
  assert.equal(retest.status, 201);
  assert.equal(retest.body.data.retestOfId, 'AT-P5B-01');
  const history = await api('/api/v1/students/S001/assessment-attempts');
  assert.equal(history.status, 200);
  assert.ok(history.body.data.some(x => x.id === 'AT-P5B-01'));
  assert.ok(history.body.data.some(x => x.retestOfId === 'AT-P5B-01'));
  const legacy = await api('/api/v1/assessments/A001');
  assert.equal(legacy.status, 200);
  assert.equal(legacy.body.data.vals.serve, 72);
});


test('26 P5-C：三阶段试测协议包含可执行测试卡、标准条件和描述性锚点', async () => {
  const list = await api('/api/v1/assessment-protocols');
  assert.equal(list.status, 200);
  assert.equal(list.body.data.length, 3);
  for (const protocol of list.body.data) {
    assert.equal(protocol.status, 'draft');
    assert.equal(protocol.conditions.calibration, '试测阶段至少安排教练共同观察和复核；不得自动形成晋级结论');
    assert.ok(protocol.conditions.safety.includes('立即停止'));
    assert.ok(protocol.criteria.length >= 6);
    for (const criterion of protocol.criteria) {
      assert.equal(criterion.testProtocol.protocolVersion, 'pilot-v1');
      assert.ok(criterion.testProtocol.setup);
      assert.ok(criterion.testProtocol.procedure.length >= 3);
      assert.ok(criterion.testProtocol.valid_trial);
      assert.ok(criterion.testProtocol.record_fields.length >= 3);
      assert.ok(criterion.testProtocol.safety_stop);
      assert.ok(criterion.testProtocol.adaptations);
      assert.equal(criterion.testProtocol.passThreshold, null);
      assert.equal(criterion.rubric.levels.length, 5);
      assert.equal(criterion.rubric.levels[0].score, 0);
      assert.ok(criterion.rubric.note.includes('不得据此自动晋级') || criterion.rubric.note.includes('试测后校准'));
    }
  }
  const s1 = list.body.data.find(p => p.stage === 1);
  assert.ok(s1.criteria.find(c => c.code === 'third_shot_drop').testProtocol.procedure.some(x => x.includes('第三拍')));
  const s2 = list.body.data.find(p => p.stage === 2);
  assert.ok(s2.criteria.find(c => c.code === 'volley_selection').testProtocol.safety_stop.includes('身体'));
  const s3 = list.body.data.find(p => p.stage === 3);
  assert.ok(s3.criteria.find(c => c.code === 'hands_battle_counter').testProtocol.safety_stop.includes('头面部'));
});


test('27 P5-D：教练复核后生成补训计划，并仅复测指定未达标能力项', async () => {
  const created = await api('/api/v1/assessment-attempts', {
    method: 'POST',
    body: JSON.stringify({ id: 'AT-P5D-01', studentId: 'S001', protocolId: 'AP-STAGE1-V1', assessmentDate: '2026-11-18', lessonNumber: 16 })
  });
  assert.equal(created.status, 201);
  const criteria = created.body.data.protocolSnapshot.criteria;
  const saved = await api('/api/v1/assessment-attempts/AT-P5D-01/results', {
    method: 'PUT',
    body: JSON.stringify({ results: criteria.map(c => ({
      criterionId: c.id, score: 2, achieved: null,
      rawTrials: [{ attempt: 1, observation: 'pilot evidence' }],
      observations: '试测证据'
    })) })
  });
  assert.equal(saved.status, 200);
  const beforeReview = await api('/api/v1/assessment-attempts/AT-P5D-01/remediation');
  assert.equal(beforeReview.status, 200);
  assert.equal(beforeReview.body.data.canCreatePlan, false, '未复核时不得推断补训项');
  const target = criteria.find(c => c.code === 'third_shot_drop');
  for (const c of criteria) {
    const status = c.code === 'third_shot_drop' ? 'needs_remediation' : 'confirmed';
    const review = await api('/api/v1/assessment-attempts/AT-P5D-01/results/' + c.code + '/review', {
      method: 'PUT', body: JSON.stringify({ status, note: '教练复核记录' })
    });
    assert.equal(review.status, 200);
  }
  const preview = await api('/api/v1/assessment-attempts/AT-P5D-01/remediation');
  assert.equal(preview.status, 200);
  assert.equal(preview.body.data.canCreatePlan, true);
  assert.equal(preview.body.data.needsRemediation.length, 1);
  assert.equal(preview.body.data.needsRemediation[0].criterionCode, 'third_shot_drop');
  assert.ok(preview.body.data.needsRemediation[0].skillPoints.length > 0, '应尝试映射到现有48课次技术点');
  const plan = await api('/api/v1/assessment-attempts/AT-P5D-01/remediation-plans', {
    method: 'POST', body: JSON.stringify({ coachNote: '按基础控制优先补训' })
  });
  assert.equal(plan.status, 201);
  assert.equal(plan.body.data.status, 'draft');
  assert.equal(plan.body.data.items.length, 1);
  const confirmed = await api('/api/v1/assessment-remediation-plans/' + plan.body.data.id + '/confirm', { method: 'POST' });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.data.status, 'confirmed');
  const retest = await api('/api/v1/assessment-retests', {
    method: 'POST',
    body: JSON.stringify({ studentId: 'S001', protocolId: 'AP-STAGE1-V1', retestOfId: 'AT-P5D-01',
      remediationPlanId: plan.body.data.id, criterionCodes: ['third_shot_drop'] })
  });
  assert.equal(retest.status, 201);
  assert.deepEqual(retest.body.data.criteriaScope, ['third_shot_drop']);
  const outside = await api('/api/v1/assessment-attempts/' + retest.body.data.id + '/results', {
    method: 'PUT',
    body: JSON.stringify({ results: [{ criterionId: criteria.find(c => c.code === 'nvz_dink').id, score: 3 }] })
  });
  assert.equal(outside.status, 422, '复测不得录入范围外能力项');
  const inside = await api('/api/v1/assessment-attempts/' + retest.body.data.id + '/results', {
    method: 'PUT',
    body: JSON.stringify({ results: [{ criterionId: target.id, score: 3, rawTrials: [{ attempt: 1, observation: 'retest' }] }] })
  });
  assert.equal(inside.status, 200);
  const original = await api('/api/v1/assessment-attempts/AT-P5D-01');
  assert.equal(original.body.data.results.find(x => x.criterionCode === 'third_shot_drop').score, 2,
    '复测不得覆盖原评估原始成绩');
  assert.equal(original.body.data.conclusion, null, '补训闭环不得自动晋级');
});

test('28 P6：体能测评表 9 项 / 9 维，分档与免责说明齐全', async () => {
  const r = await api('/api/v1/fitness-battery');
  assert.equal(r.status, 200);
  const b = r.body.data;
  assert.equal(b.items.length, 9, '应为 9 个实测项目');
  assert.equal(b.dimensions.length, 9, '应为 9 个身体维度');
  assert.ok(b.ageGroups.length >= 5, '应覆盖少儿到常青的年龄组');
  assert.ok(b.calibrationNote && /不是官方常模/.test(b.calibrationNote), '必须声明分档不是官方常模');
  for (const item of b.items) {
    assert.ok(item.protocol && item.safety, item.code + ' 必须有测试协议与安全说明');
    assert.equal(item.anchors.length, 5, item.code + ' 应有 5 档锚点');
  }
  assert.ok(b.items.every(i => (i.sexFactor && i.sexFactor.male != null) || i.code === 'step_hr'));
});

test('29 P6：录入实测值生成报告，未测项不当作 0 分，完成前不可写入档案', async () => {
  const created = await api('/api/v1/fitness-assessments', {
    method: 'POST',
    body: JSON.stringify({ studentId: 'S001', sex: 'male', ageGroupCode: 'a18', testDate: '2026-11-18' })
  });
  assert.equal(created.status, 201);
  const id = created.body.data.id;
  assert.equal(created.body.data.status, 'draft');
  assert.equal(created.body.data.report.coverage.measured, 0);
  assert.equal(created.body.data.report.fitScore, null, '无实测时不得给出体能分');

  const partial = await api('/api/v1/fitness-assessments/' + id + '/results', {
    method: 'PUT',
    body: JSON.stringify({ results: [{ itemCode: 'plank', rawValue: 90 }] })
  });
  assert.equal(partial.status, 200);
  assert.equal(partial.body.data.report.coverage.measured, 1);
  assert.equal(partial.body.data.report.totalIndex, partial.body.data.report.dimensions.find(d => d.code === 'core').index,
    '只测一个维度时总分应等于该维度指数，而不是被其余维度当 0 分拉低');
  const aborted = await api('/api/v1/fitness-assessments/' + id + '/results', {
    method: 'PUT',
    body: JSON.stringify({ results: [{ itemCode: 'step_hr', rawValue: 120, status: 'aborted' }] })
  });
  assert.equal(aborted.body.data.report.results.find(r => r.itemCode === 'step_hr').indexValue, null, '中止项不计分');

  const early = await api('/api/v1/fitness-assessments/' + id + '/apply-to-student', { method: 'POST' });
  assert.equal(early.status, 409, '未完成的测评不能写入学员档案');
  const tooFew = await api('/api/v1/fitness-assessments/' + id + '/finalize', { method: 'POST' });
  assert.equal(tooFew.status, 422, '项目不足时不能生成报告');
  assert.match(tooFew.body.error.message, /未测项目不会被当作 0 分/);
});

test('30 P6：完整测评生成图文报告并写入入班体能，完成后锁定且不改写历史', async () => {
  const created = await api('/api/v1/fitness-assessments', {
    method: 'POST',
    body: JSON.stringify({ studentId: 'S001', sex: 'male', ageGroupCode: 'a18', heightCm: 176, weightKg: 72 })
  });
  const id = created.body.data.id;
  const results = [
    ['reaction_ruler', 16], ['sit_reach', 8], ['single_leg', 28], ['wall_rally', 22],
    ['slj', 182], ['agility_5_10_5', 6.3], ['pushup_30s', 20], ['plank', 80], ['step_hr', 140]
  ].map(([itemCode, rawValue]) => ({ itemCode, rawValue, status: 'measured' }));
  const saved = await api('/api/v1/fitness-assessments/' + id + '/results', { method: 'PUT', body: JSON.stringify({ results }) });
  assert.equal(saved.status, 200);
  const rep = saved.body.data.report;
  assert.equal(rep.coverage.measured, 9);
  assert.ok(rep.totalIndex > 0 && rep.totalIndex <= 100);
  assert.equal(rep.dimensions.length, 9);
  assert.ok(rep.strongest.length === 2 && rep.weakest.length === 2, '应给出强项与补强项');
  assert.ok(saved.body.data.advice.suggestions.length > 0, '应给出计划适配建议');

  const finalized = await api('/api/v1/fitness-assessments/' + id + '/finalize', { method: 'POST', body: JSON.stringify({ notes: '首次入班测评' }) });
  assert.equal(finalized.status, 200);
  assert.equal(finalized.body.data.status, 'completed');
  const fitScore = finalized.body.data.report.fitScore;
  assert.ok(Number.isInteger(fitScore) && fitScore >= 0 && fitScore <= 5);

  const applied = await api('/api/v1/fitness-assessments/' + id + '/apply-to-student', { method: 'POST', body: JSON.stringify({}) });
  assert.equal(applied.status, 200);
  assert.equal(applied.body.data.fitScore, fitScore);
  const student = await api('/api/v1/students/S001');
  assert.equal(student.body.data.fitScore, fitScore, '入班体能应写入学员档案');

  const locked = await api('/api/v1/fitness-assessments/' + id + '/results', {
    method: 'PUT', body: JSON.stringify({ results: [{ itemCode: 'plank', rawValue: 200 }] })
  });
  assert.equal(locked.status, 409, '完成后不可改写');
  const reread = await api('/api/v1/fitness-assessments/' + id);
  assert.equal(reread.body.data.report.results.find(r => r.itemCode === 'plank').rawValue, 80, '历史原始值不被覆盖');

  const latest = await api('/api/v1/students/S001/fitness-latest');
  assert.equal(latest.body.data.assessment.id, id);
  const list = await api('/api/v1/students/S001/fitness-assessments');
  assert.ok(list.body.data.items.length >= 2);
  assert.ok(list.body.data.trend.length >= 1);
});

test('31 P6：常青与少儿按年龄组让步，替代变体按分档折算，异常输入返回 422', async () => {
  const battery = (await api('/api/v1/fitness-battery')).body.data;
  const adult = battery.ageGroups.find(g => g.code === 'a18');
  const senior = battery.ageGroups.find(g => g.code === 'a55');
  const youth = battery.ageGroups.find(g => g.code === 'u12');
  const scoring = require('../src/services/fitness-scoring');
  const spec = JSON.parse(JSON.stringify(battery));
  const raw = 120; // 3 分钟台阶后 1 分钟心率
  const adultIdx = scoring.scoreItem(spec, { itemCode: 'step_hr', rawValue: raw }, { ageGroup: adult, sex: 'male' }).indexValue;
  const seniorIdx = scoring.scoreItem(spec, { itemCode: 'step_hr', rawValue: raw }, { ageGroup: senior, sex: 'male' }).indexValue;
  assert.ok(seniorIdx > adultIdx, '同样心率下常青应按年龄让步得到更高指数');
  // 年龄组让步方向必须分维度：常青在有氧上让步，少儿在爆发上让步、在柔韧上执行更高标准
  const youthFlex = scoring.scoreItem(spec, { itemCode: 'sit_reach', rawValue: 6 }, { ageGroup: youth, sex: 'male' }).indexValue;
  const adultFlex = scoring.scoreItem(spec, { itemCode: 'sit_reach', rawValue: 6 }, { ageGroup: adult, sex: 'male' }).indexValue;
  assert.ok(youthFlex < adultFlex, '少儿柔韧应执行更高标准，而不是被统一折扣压低');
  const youthPower = scoring.scoreItem(spec, { itemCode: 'slj', rawValue: 150 }, { ageGroup: youth, sex: 'male' }).indexValue;
  const adultPower = scoring.scoreItem(spec, { itemCode: 'slj', rawValue: 150 }, { ageGroup: adult, sex: 'male' }).indexValue;
  assert.ok(youthPower > adultPower, '同样跳 150cm，少儿应按发育让步得到更高指数');
  assert.ok(Math.abs(youthFlex - adultFlex) < Math.abs(youthPower - adultPower) + 20, '让步幅度应可解释，不应出现极端放大');
  const knee = scoring.scoreItem(spec, { itemCode: 'pushup_30s', rawValue: 20, variantCode: 'knee' }, { ageGroup: adult, sex: 'male' }).indexValue;
  const std = scoring.scoreItem(spec, { itemCode: 'pushup_30s', rawValue: 20 }, { ageGroup: adult, sex: 'male' }).indexValue;
  assert.ok(knee < std, '跪姿俯卧撑必须折算，不能与标准俯卧撑同分');

  const bad = await api('/api/v1/fitness-assessments', { method: 'POST', body: JSON.stringify({ studentId: 'S001', sex: 'x' }) });
  assert.equal(bad.status, 422);
  const missing = await api('/api/v1/fitness-assessments', { method: 'POST', body: JSON.stringify({ studentId: 'NOPE' }) });
  assert.equal(missing.status, 404);
  const fresh = await api('/api/v1/fitness-assessments', { method: 'POST', body: JSON.stringify({ studentId: 'S001', ageGroupCode: 'a18' }) });
  const invalid = await api('/api/v1/fitness-assessments/' + fresh.body.data.id + '/results', {
    method: 'PUT', body: JSON.stringify({ results: [{ itemCode: 'plank', rawValue: 'abc' }] })
  });
  assert.equal(invalid.status, 422);
  const unknown = await api('/api/v1/fitness-assessments/' + fresh.body.data.id + '/results', {
    method: 'PUT', body: JSON.stringify({ results: [{ itemCode: 'no_such_item', rawValue: 1 }] })
  });
  assert.equal(unknown.status, 422);
  assert.equal(unknown.body.error.code, 'UNKNOWN_ITEM');
});

/* ============================================================
   P7 · 课程包 → 课程大纲 → 备课 → 执行 → 点评
   ============================================================ */

test('32 P7：难度表下发 24 单元，且明确声明为教练估算、非官方校准', async () => {
  const r = await api('/api/v1/curriculum-difficulty');
  assert.equal(r.status, 200);
  const d = r.body.data;
  assert.equal(d.units.length, 24);
  assert.ok(d.calibrationNote && /未经实验校准|教练经验/.test(d.calibrationNote), '必须声明难度表不是实验数据');
  assert.equal(d.doseModel.maxNewPointsPerLesson, 3, '单课并列新授点上限必须是硬约束');
  assert.ok(d.units.every(u => u.difficulty >= 1 && u.difficulty <= 5 && u.tech), '每个单元要有难度与主题');
  assert.ok(d.missingCoverage.some(m => /单打/.test(m.name)), '必须如实记录「没有单打模块」');
});

test('33 P7：登记课程包 → 生成 N 节大纲（课次受难度与剂量驱动，且不改变单次时长）', async () => {
  await api('/api/v1/students', {
    method: 'POST',
    body: JSON.stringify({ id: 'S-P7-01', name: '课程包学员 · 甲', age: 'adult', stage: 1, techScore: 2, fitScore: 2, total: 48, used: 0 })
  });
  const r = await api('/api/v1/enrollments', {
    method: 'POST',
    body: JSON.stringify({ studentId: 'S-P7-01', totalLessons: 10, lessonsPerWeek: 2, minutesPerLesson: 90, startDate: '2026-11-18', paceMode: 'adaptive' })
  });
  assert.equal(r.status, 201);
  const e = r.body.data;
  assert.equal(e.outline.length, 10, '买 10 节就排 10 节');
  assert.equal(e.usedLessons, 0);
  assert.ok(e.outline.every(o => o.minutes === 90), '单次时长不得被难度改动');
  assert.ok(e.outline.every(o => o.lessonNo >= 1 && o.lessonNo <= 48), '课次必须落在 48 课次内');
  assert.equal(e.outline[0].lessonType, 'A', '第一节必须是新授课');
  assert.deepEqual(e.outline.map(o => o.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.ok(e.outline.every(o => /^\d{4}-\d{2}-\d{2}$/.test(o.plannedDate)), '每节都要有排课日期');
  assert.ok(e.generated.truncated === true && /不足以覆盖/.test(e.generated.truncatedReason),
    '10 节不可能覆盖 24 单元，必须如实提示而不是装作排完了');
  assert.ok(e.generated.byUnit.every(u => u.reason && /实球触球/.test(u.reason)), '每个单元要能解释为什么排这么多节');
});

test('34 P7：执行一节课 = 一个事务（授课记录 + 大纲状态 + 课程包已用 + 学员已耗），且幂等', async () => {
  const list = await api('/api/v1/enrollments?studentId=S-P7-01');
  const enroll = list.body.data.items[0];
  const first = enroll.outline[0];

  const before = await api('/api/v1/students/S-P7-01');
  const usedBefore = before.body.data.used;

  const r = await api(`/api/v1/enrollments/${enroll.id}/lessons`, {
    method: 'POST', body: JSON.stringify({ outlineLessonId: first.id, date: '2026-11-18', judge: '部分达标', rpe: 5 })
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.data.duplicated, false);
  assert.equal(r.body.data.session.lesson, first.lessonNo);
  assert.equal(r.body.data.session.reviewStatus, 'pending', '执行后必须是待点评');
  assert.equal(r.body.data.outlineLesson.status, 'taught');
  assert.ok(r.body.data.nextStep && /补强|复习/.test(r.body.data.nextStep.text), '执行完必须给出下一步建议');

  const after = await api(`/api/v1/enrollments/${enroll.id}`);
  assert.equal(after.body.data.usedLessons, 1, '课程包已用课时 +1');
  const studentAfter = await api('/api/v1/students/S-P7-01');
  assert.equal(studentAfter.body.data.used, usedBefore + 1, '学员已耗课次同步 +1');

  // 幂等：重复点执行不会产生第二条记录
  const again = await api(`/api/v1/enrollments/${enroll.id}/lessons`, {
    method: 'POST', body: JSON.stringify({ outlineLessonId: first.id, date: '2026-11-18' })
  });
  assert.equal(again.body.data.duplicated, true);
  assert.equal(again.body.data.session.id, r.body.data.session.id, '必须返回同一份记录');
  const againEnroll = await api(`/api/v1/enrollments/${enroll.id}`);
  assert.equal(againEnroll.body.data.usedLessons, 1, '重复执行不得重复扣课时');
});

test('35 P7：课后点评写入 3 要点达成，并把未达标的大纲顺延为同单元补强课', async () => {
  const list = await api('/api/v1/enrollments?studentId=S-P7-01');
  const enroll = list.body.data.items[0];
  const taught = enroll.outline.find(o => o.status === 'taught');
  const nextSeq = enroll.outline.find(o => o.seq === taught.seq + 1);

  const r = await api(`/api/v1/sessions/${taught.sessionId}/review`, {
    method: 'POST',
    body: JSON.stringify({
      judge: '部分达标', attend: '出勤', rpe: 5, note: '拍面稳定；回中偏慢',
      homework: '对墙 30 次 × 2 组', nextFocus: '击球点前移 10 cm',
      judgeVals: { kp1: true, kp2: false, kp3: false }
    })
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.session.reviewStatus, 'done');
  assert.equal(r.body.data.session.judge, '部分达标');
  assert.equal(r.body.data.session.homework, '对墙 30 次 × 2 组');
  assert.deepEqual(r.body.data.session.judgeVals, { kp1: true, kp2: false, kp3: false });
  assert.equal(r.body.data.adjust.action, 'insert_r', '未达标应把下一节改成补强课');

  const after = await api(`/api/v1/enrollments/${enroll.id}`);
  const changed = after.body.data.outline.find(o => o.seq === nextSeq.seq);
  assert.equal(changed.lessonType, 'R', '下一节应变为 R 补强');
  assert.equal(changed.unitNo, taught.unitNo, '补强课必须在同一单元，不能跳到新单元');
  assert.equal(after.body.data.outline.length, enroll.outline.length, '不得偷偷增加课时');
  assert.equal(after.body.data.progress.reviewed, 1);

  // 非法判据被拒
  const bad = await api(`/api/v1/sessions/${taught.sessionId}/review`, {
    method: 'POST', body: JSON.stringify({ judge: '完美' })
  });
  assert.equal(bad.status, 422);
});

test('36 P7：固定节奏不插入补强课；今日视图只返回当天待上课次', async () => {
  await api('/api/v1/students', {
    method: 'POST', body: JSON.stringify({ id: 'S-P7-02', name: '课程包学员 · 乙', age: 'senior', stage: 1, techScore: 2, fitScore: 2 })
  });
  const created = await api('/api/v1/enrollments', {
    method: 'POST',
    body: JSON.stringify({ studentId: 'S-P7-02', totalLessons: 4, lessonsPerWeek: 2, startDate: '2026-12-01', paceMode: 'fixed' })
  });
  const e = created.body.data;
  assert.ok(e.outline.every(o => o.lessonType !== 'R'), '固定节奏不得排 R 课');

  const ex = await api(`/api/v1/enrollments/${e.id}/lessons`, {
    method: 'POST', body: JSON.stringify({ outlineLessonId: e.outline[0].id, date: '2026-12-01', judge: '未达标' })
  });
  assert.equal(ex.status, 201);
  assert.equal(ex.body.data.nextStep.action, 'hold', '固定节奏未达标只做 hold，不加课');

  const rv = await api(`/api/v1/sessions/${ex.body.data.session.id}/review`, {
    method: 'POST', body: JSON.stringify({ judge: '未达标', homework: '徒手 20 次' })
  });
  assert.equal(rv.body.data.adjust.action, 'hold');
  const after = await api(`/api/v1/enrollments/${e.id}`);
  assert.ok(after.body.data.outline.every(o => o.lessonType !== 'R'), '点评后也不得擅自插入补强课');

  const board = await api('/api/v1/today?date=2026-12-05');
  assert.equal(board.status, 200);
  assert.ok(Array.isArray(board.body.data.lessons));
  assert.ok(board.body.data.lessons.every(o => o.plannedDate === '2026-12-05'), '今日视图只能返回当天');
  assert.ok(board.body.data.unreviewed.some(x => x.id === ex.body.data.session.id) === false,
    '已点评的记录不应再出现在待点评里');
  assert.ok(board.body.data.counts && typeof board.body.data.counts.unreviewed === 'number');
});

test('37 P7：课程包与大纲随 state 下发（离线也能看今天上哪节），且异常输入被拒', async () => {
  const st = await api('/api/v1/state');
  assert.equal(st.status, 200);
  assert.ok(Array.isArray(st.body.data.enrollments));
  const e = st.body.data.enrollments.find(x => x.studentName === '课程包学员 · 甲');
  assert.ok(e && e.outline.length === 10, 'state 必须带大纲，供离线查看');
  assert.ok(e.outline.every(o => o.lessonNo >= 1 && o.unitNo >= 1));

  const noStudent = await api('/api/v1/enrollments', { method: 'POST', body: JSON.stringify({ totalLessons: 5 }) });
  assert.equal(noStudent.status, 422);
  const badTotal = await api('/api/v1/enrollments', {
    method: 'POST', body: JSON.stringify({ studentId: 'S-P7-01', totalLessons: 0 })
  });
  assert.equal(badTotal.status, 422);
  const ghost = await api('/api/v1/enrollments', {
    method: 'POST', body: JSON.stringify({ studentId: 'NO-SUCH', totalLessons: 5 })
  });
  assert.equal(ghost.status, 404);
  const wrongOutline = await api(`/api/v1/enrollments/${e.id}/lessons`, {
    method: 'POST', body: JSON.stringify({ outlineLessonId: 'OL-NOT-EXIST' })
  });
  assert.equal(wrongOutline.status, 404, '不能执行不属于该课程包的大纲课次');
});

/* ============================================================
   P7 · 可嵌入与监听地址（云预览相关，安全默认不变）
   ============================================================ */

test('38 默认禁止被嵌入；显式配置 ALLOW_EMBED_ORIGINS 时只放开白名单来源', async () => {
  // 默认（未配置）：必须仍然是 DENY + frame-ancestors 'none'
  const def = await api('/');
  assert.equal(def.headers.get('x-frame-options'), 'DENY', '默认必须禁止被嵌入');
  assert.match(def.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);

  // 配置后：移除 DENY，改为精确白名单；非法值（含 *）被过滤掉
  const cfgPath = require.resolve('../src/config');
  const cfg = require(cfgPath);
  const mwPath = require.resolve('../src/middlewares');
  const saved = cfg.allowEmbedOrigins;
  try {
    cfg.allowEmbedOrigins = ['https://8787-abc.e2b.app'];
    delete require.cache[mwPath];
    const mw = require(mwPath);
    const headers = {};
    mw.applySecurity({ path: '/', res: { setHeader: (k, v) => { headers[k] = v; } } });
    assert.equal(headers['X-Frame-Options'], undefined, '放开后不应再发 DENY（会覆盖 CSP）');
    assert.match(headers['Content-Security-Policy'], /frame-ancestors 'self' https:\/\/8787-abc\.e2b\.app/);
    assert.ok(!/\*/.test(headers['Content-Security-Policy'].split('frame-ancestors')[1].split(';')[0]),
      'frame-ancestors 不允许出现通配符');
  } finally {
    cfg.allowEmbedOrigins = saved;
    delete require.cache[mwPath];
  }
});

test('39 ALLOW_EMBED_ORIGINS 不接受通配符或非法来源', async () => {
  const { execFileSync } = require('node:child_process');
  const read = (val) => execFileSync(process.execPath, ['-e',
    `process.env.ALLOW_EMBED_ORIGINS=${JSON.stringify(val)};process.env.ADMIN_PASSWORD='x';` +
    `console.log(JSON.stringify(require('./backend/src/config').allowEmbedOrigins))`
  ], { cwd: require('node:path').join(__dirname, '..', '..'), encoding: 'utf8' }).trim();
  assert.deepEqual(JSON.parse(read('*')), [], '不能接受通配符');
  assert.deepEqual(JSON.parse(read('https://a.com,http://b.com,*.foo.com')), ['https://a.com'],
    '只保留精确 https 来源');
  assert.deepEqual(JSON.parse(read('https://preview.e2b.app,https://other.app')),
    ['https://preview.e2b.app', 'https://other.app']);
  // https 子域通配是合法的 CSP host-source，允许；裸 * 与 http 公网仍拒绝
  assert.deepEqual(JSON.parse(read('https://*.e2b.app,*')), ['https://*.e2b.app']);
  assert.deepEqual(JSON.parse(read('http://evil.com')), [], '公网 http 来源不接受（会被中间人篡改）');
});

/* ============================================================
   P8 · 登录不再反复弹窗：长有效期 + 静默续期
   ============================================================ */

test('40 令牌默认 12 小时，登录返回到期时间与续期宽限期', async () => {
  const { signToken, verifyToken } = require('../src/utils/crypto');
  const config = require('../src/config');
  assert.equal(config.jwtTtlSeconds, 43200, '默认应为 12 小时，而不是 15 分钟');
  assert.ok(config.jwtRefreshGraceSeconds >= 600, '应留出续期宽限期');

  const r = await api('/api/v1/auth/login', {
    method: 'POST', body: JSON.stringify({ username: 'admin', password: 'test-password-123' })
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.data.expires_in, 43200);
  assert.equal(r.body.data.refresh_grace, config.jwtRefreshGraceSeconds);

  const payload = verifyToken(r.body.data.token);
  assert.ok(payload.exp - payload.iat === 43200, 'JWT 内的有效期也要是 12 小时');

  // 4 小时后的令牌仍然可用（老版本 15 分钟时这里早就 401 了）
  const later = signToken({ sub: payload.sub, username: payload.username, role: payload.role }, 4 * 3600);
  const mid = await api('/api/v1/state', { headers: { authorization: 'Bearer ' + later } });
  assert.equal(mid.status, 200, '营业中途不应因为令牌过期而要求重新登录');
});

test('41 续期接口：有效令牌换新令牌，签名错一律拒绝', async () => {
  const { signToken } = require('../src/utils/crypto');
  const login = await api('/api/v1/auth/login', {
    method: 'POST', body: JSON.stringify({ username: 'admin', password: 'test-password-123' })
  });
  const oldToken = login.body.data.token;

  const before = JSON.parse(Buffer.from(oldToken.split('.')[1], 'base64url').toString());
  const r = await apiAs('/api/v1/auth/refresh', oldToken, { method: 'POST', body: '{}' });
  assert.equal(r.status, 200);
  assert.ok(r.body.data.token, '应返回令牌');
  // 同一秒内签发的 JWT 内容完全相同（iat/exp 精度为秒），因此只校验「有效期不倒退」，
  // 不强行要求字符串不同——否则这个断言会变成不稳定测试。
  assert.ok(r.body.data.token.split('.').length === 3);
  assert.equal(r.body.data.refreshed, true);
  const after = JSON.parse(Buffer.from(r.body.data.token.split('.')[1], 'base64url').toString());
  assert.ok(after.exp >= before.exp, '续期后到期时间不应倒退');

  // 新令牌可用
  const used = await apiAs('/api/v1/state', r.body.data.token);
  assert.equal(used.status, 200);

  // 伪造签名：即使未过期也拒绝
  const forged = signToken({ sub: 'U-FAKE', username: 'x', role: 'admin' });
  const bad = await apiAs('/api/v1/auth/refresh', forged.slice(0, -3) + 'AAA', { method: 'POST', body: '{}' });
  assert.equal(bad.status, 401);

  // 没有令牌
  const none = await apiAs('/api/v1/auth/refresh', '', { method: 'POST', body: '{}' });
  assert.equal(none.status, 401);
});

test('42 续期宽限期：刚过期可续，超过宽限期必须重新登录', async () => {
  const { signToken, verifyTokenAllowExpired } = require('../src/utils/crypto');
  const config = require('../src/config');
  const user = require('../src/db/connection').get("SELECT * FROM users WHERE username = 'admin' AND deleted_at IS NULL");
  const claims = { sub: user.id, username: user.username, role: user.role };

  // 已过期 5 分钟：仍在宽限期内 → 续期成功
  const justExpired = signToken(claims, -300);
  const ok = await apiAs('/api/v1/auth/refresh', justExpired, { method: 'POST', body: '{}' });
  assert.equal(ok.status, 200, '合盖休眠回来应能静默续期，不打断用户');

  // 已过期超过宽限期 → 拒绝，前端据此显示「重新登录」提示条而不是反复弹窗
  const longExpired = signToken(claims, -(config.jwtRefreshGraceSeconds + 60));
  const expired = await apiAs('/api/v1/auth/refresh', longExpired, { method: 'POST', body: '{}' });
  assert.equal(expired.status, 401);
  assert.equal(expired.body.error.code, 'REFRESH_EXPIRED');

  // 但普通接口此时仍必须拒绝（宽限只对续期接口生效，不放宽数据访问）
  const data = await apiAs('/api/v1/state', justExpired);
  assert.equal(data.status, 401, '过期令牌不能直接访问数据');

  assert.equal(verifyTokenAllowExpired(justExpired, 3600) !== null, true);
  assert.equal(verifyTokenAllowExpired(justExpired, 0), null);
});

test('43 停用账号不能通过续期绕过', async () => {
  const { signToken } = require('../src/utils/crypto');
  const conn = require('../src/db/connection');
  const u = conn.get("SELECT * FROM users WHERE username = 'admin' AND deleted_at IS NULL");
  conn.run('UPDATE users SET is_active = 0 WHERE id = ?', [u.id]);
  try {
    const tok = signToken({ sub: u.id, username: u.username, role: u.role }, 3600);
    const r = await apiAs('/api/v1/auth/refresh', tok, { method: 'POST', body: '{}' });
    assert.equal(r.status, 401);
    assert.equal(r.body.error.code, 'ACCOUNT_DISABLED');
  } finally {
    conn.run('UPDATE users SET is_active = 1 WHERE id = ?', [u.id]);
  }
});
