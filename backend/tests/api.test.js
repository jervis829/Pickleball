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
