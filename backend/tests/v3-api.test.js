'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP_DB = path.join(os.tmpdir(), `pkb-v3-test-${process.pid}.db`);
for (const ext of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(TMP_DB + ext); } catch (_) {}
}

process.env.DB_FILE = TMP_DB;
process.env.ADMIN_USER = 'admin';
process.env.ADMIN_PASSWORD = 'v3-test-password-123';
process.env.RATE_LIMIT_MAX = '100000';

const { migrate } = require('../src/db/migrate');
const { seed } = require('../../database/seeds/seed');
const { createServer } = require('../src/server');

migrate();
seed({ skipMigrate: true });

let server, base, token;

async function req(method, urlPath, body) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = 'Bearer ' + token;
  const res = await fetch(base + urlPath, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, payload: data, data: data && data.data !== undefined ? data.data : data };
}

test.before(async () => {
  server = createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = 'http://127.0.0.1:' + server.address().port;
  const login = await req('POST', '/api/v1/auth/login', { username: 'admin', password: process.env.ADMIN_PASSWORD });
  assert.equal(login.status, 200);
  token = login.data.token;
});

test.after(async () => {
  await new Promise(r => server.close(r));
  for (const ext of ['', '-wal', '-shm']) {
    try { fs.unlinkSync(TMP_DB + ext); } catch (_) {}
  }
});

let stuAId, stuBId, planId, firstLessonId, secondLessonId, baselineSnapId;

test('V3-01 默认大纲配置：34 模块（B01-B12 顺排 + A01-A22 选修）、无 B00 独立课、无 A23', async () => {
  const r = await req('GET', '/api/v1/v3/curriculum/config');
  assert.equal(r.status, 200);
  const cfg = r.data;
  assert.equal(cfg.defaultMinutes, 60);
  assert.equal(cfg.tracks.length, 2);
  assert.equal(cfg.categories.length, 7);
  assert.equal(cfg.modules.length, 34);
  const codes = new Set(cfg.modules.map(m => m.code));
  assert.equal(codes.has('B00'), false);
  assert.equal(codes.has('A23'), false);
  for (let i = 1; i <= 12; i++) assert.equal(codes.has('B' + String(i).padStart(2, '0')), true);
  for (let i = 1; i <= 22; i++) assert.equal(codes.has('A' + String(i).padStart(2, '0')), true);
  const a05_08 = cfg.modules.filter(m => ['A05', 'A06', 'A07', 'A08'].includes(m.code)).map(m => m.title + m.kp.join(',')).join(' ');
  assert.match(a05_08, /Drip|第五拍/);
});

test('V3-02 建档默认全模块 0=不会 + 口头预填 + 自动冻结基线快照 + 7类 0-10 算分', async () => {
  const rA = await req('POST', '/api/v1/v3/students', {
    name: '林小满', gender: 'female', fitnessAgeGroup: 'a18', racketBg: '纯零基础', target: '3.0', initialScores: {}
  });
  assert.equal(rA.status, 201);
  stuAId = rA.data.student.id;
  assert.equal(rA.data.assessment.overallScore, 0);
  assert.equal(rA.data.assessment.modules.length, 34);
  assert.ok(rA.data.assessment.modules.every(m => m.score === 0));
  assert.equal(rA.data.latestSnapshot.triggerType, 'baseline');
  baselineSnapId = rA.data.latestSnapshot.id;

  // 验证 7 大类初阶 6 分 + 进阶前 K 项 4 分混合算分公式
  const rB = await req('POST', '/api/v1/v3/students', {
    name: '张维舟', gender: 'male', fitnessAgeGroup: 'a35', racketBg: '网球4年', target: '3.5',
    initialScores: { B01: 5, B04: 5, A01: 5, A02: 5 }
  });
  assert.equal(rB.status, 201);
  stuBId = rB.data.student.id;
  // C1(发球与接发球): B01=5, B04=5 -> 初阶满分6; A01=5, A02=5 (advTopK=2) -> 进阶满分4 => C1=10.0!
  const c1 = rB.data.assessment.categories.find(c => c.id === 'C1');
  assert.equal(c1.score, 10);
});

test('V3-03 零道具 6 维球场体能测评：区分性别×年龄段、跳过不计 0 分、无心率无目测', async () => {
  const bat = await req('GET', '/api/v1/v3/fitness/battery');
  assert.equal(bat.status, 200);
  assert.deepEqual(bat.data.dimensions.map(d => d.name), ['爆发力', '反应', '移动', '平衡', '柔韧', '耐力']);

  const fitA = await req('POST', `/api/v1/v3/students/${stuAId}/fitness`, {
    testDate: '2026-11-18',
    gender: 'female',
    ageGroup: 'a18',
    raw: {
      power: { skipped: true, skipReason: '生理期跳过爆发动作' },
      reaction: { value: 4 },
      mobility: { value: 6.5 }, // 18-34 女性 p10 偏弱 -> 触发移动课堂联动
      balance: { value: 36 },
      flexibility: { bendLevel: 4, shoulderLevel: 3 },
      endurance: { value: 18 }
    }
  });
  assert.equal(fitA.status, 201);
  const pwr = fitA.data.dimensions.find(d => d.key === 'power');
  assert.equal(pwr.skipped, true);
  assert.equal(pwr.score, null);
  assert.ok(fitA.data.totalIndex > 0);
  assert.ok(fitA.data.weakDims.some(w => w.key === 'mobility'));
  assert.ok(fitA.data.trainingHints.some(h => h.dimKey === 'mobility'));
  assert.ok(fitA.data.safetyNotes.some(n => n.includes('跳过不计 0 分')));
});

test('V3-04 2人小班教学计划 + 60 分钟教案（含 B01 首课前10分钟微讲 + 体能短板课堂适配）', async () => {
  const r = await req('POST', '/api/v1/v3/plans', {
    name: '林×张 2人小班',
    studentIds: [stuAId, stuBId],
    totalLessons: 10,
    defaultMinutes: 60,
    startDate: '2026-11-18',
    trackMode: 'basic_first'
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.packageType, 'small');
  assert.equal(r.data.totalLessons, 10);
  assert.equal(r.data.lessons.length, 10);
  planId = r.data.id;
  // 第一节应为 B01（因林小满 B01=0 < 2，班级木桶优先）
  assert.equal(r.data.lessons[0].moduleCode, 'B01');
  firstLessonId = r.data.lessons[0].id;
  secondLessonId = r.data.lessons[1].id;

  const lesDetail = await req('GET', `/api/v1/v3/plans/${planId}/lessons/${firstLessonId}`);
  assert.equal(lesDetail.status, 200);
  const pc = lesDetail.data.planContent;
  assert.equal(pc.totalMinutes, 60);
  assert.equal(pc.segments.reduce((a, s) => a + s.minutes, 0), 60);
  assert.ok(pc.firstLessonMicroTalk.includes('前10分钟微讲'));
  assert.ok(pc.fitnessAdaptations.some(a => a.studentId === stuAId && a.dimKey === 'mobility'));
});

test('V3-05 课后各学员独立打分：出勤改分+生成快照，缺席不改分，已上课永久锁定', async () => {
  const comp = await req('POST', `/api/v1/v3/plans/${planId}/lessons/${firstLessonId}/complete`, {
    completedDate: '2026-11-18',
    coachNote: 'B01 首课顺利完成',
    studentReviews: [
      { studentId: stuAId, attend: 'present', score: 3, rpe: 6, feedback: '发球抛球稳', homework: '空挥20次' },
      { studentId: stuBId, attend: 'absent', score: 1, feedback: '请假缺席' }
    ]
  });
  assert.equal(comp.status, 200);
  assert.equal(comp.data.plan.usedLessons, 1);
  assert.equal(comp.data.plan.lessons[0].locked, true);
  assert.equal(comp.data.generatedSnapshots.length, 1);
  assert.equal(comp.data.generatedSnapshots[0].studentId, stuAId);

  // 检查林小满 B01=3 且新增了第 2 张快照，张维舟 B01 仍为建档时的 5 且未扣个人课时
  const rptA = await req('GET', `/api/v1/v3/students/${stuAId}`);
  const rptB = await req('GET', `/api/v1/v3/students/${stuBId}`);
  assert.equal(rptA.data.snapshots.length, 2);
  assert.equal(rptA.data.latestSnapshot.triggerType, 'lesson_review');
  assert.equal(rptA.data.liveAssessment.modules.find(m => m.code === 'B01').score, 3);
  assert.equal(rptB.data.snapshots.length, 1);
  assert.equal(rptB.data.liveAssessment.modules.find(m => m.code === 'B01').score, 5);

  // 成长对比：林小满最新快照 vs 基线快照有明确正向提升
  const cmp = await req('GET', `/api/v1/v3/students/${stuAId}/snapshots/compare`);
  assert.equal(cmp.status, 200);
  assert.ok(cmp.data.overallDelta > 0);
  assert.equal(cmp.data.improvedModules.length, 1);
  assert.equal(cmp.data.improvedModules[0].code, 'B01');
  assert.equal(cmp.data.improvedModules[0].delta, 3);

  // 锁定校验：不能修改、删除、重排已完成的第 1 节
  const lockEdit = await req('PATCH', `/api/v1/v3/plans/${planId}/lessons/${firstLessonId}`, { moduleCode: 'B03' });
  assert.equal(lockEdit.status, 409);
  const lockDel = await req('DELETE', `/api/v1/v3/plans/${planId}/lessons/${firstLessonId}`);
  assert.equal(lockDel.status, 409);
});

test('V3-06 未上课次灵活调整：替换/双模块合练 + 插课 + 调序 + 续课', async () => {
  // 替换第 2 节为双模块合练 B02 + B03
  const edit = await req('PATCH', `/api/v1/v3/plans/${planId}/lessons/${secondLessonId}`, {
    moduleCode: 'B02', secondaryModuleCode: 'B03', minutes: 60
  });
  assert.equal(edit.status, 200);
  assert.equal(edit.data.lessons[1].secondaryModuleCode, 'B03');

  // 在第 2 节后插 1 节补强课
  const ins = await req('POST', `/api/v1/v3/plans/${planId}/lessons`, {
    afterLessonId: secondLessonId, moduleCode: 'B01', isRemedial: true, minutes: 60
  });
  assert.equal(ins.status, 201);
  assert.equal(ins.data.totalLessons, 11);

  // 调序：交换第 2 和第 3 节（第 1 节已锁定不动）
  const ids = ins.data.lessons.map(l => l.id);
  const reorderedIds = [ids[0], ids[2], ids[1], ...ids.slice(3)];
  const reo = await req('POST', `/api/v1/v3/plans/${planId}/reorder`, { orderedLessonIds: reorderedIds });
  assert.equal(reo.status, 200);
  assert.equal(reo.data.lessons[1].moduleCode, 'B01');

  // 续课 +2 节
  const ext = await req('POST', `/api/v1/v3/plans/${planId}/extend`, { addLessons: 2 });
  assert.equal(ext.status, 200);
  assert.equal(ext.data.totalLessons, 13);
});

test('V3-07 大纲热配置扩展高阶赛道：新模块同步生效，历史快照完全冻结不受影响', async () => {
  const cfgRes = await req('GET', '/api/v1/v3/curriculum/config');
  const nextCfg = JSON.parse(JSON.stringify(cfgRes.data));
  nextCfg.version = '2.3.0-ext';
  nextCfg.tracks.push({ id: 'high', name: '高阶竞技', order: 3, mode: 'elective', weightMax: 2 });
  nextCfg.modules.push({
    code: 'H01', seq: 35, track: 'high', categoryId: 'C7', title: '高阶双打快变叠位战术',
    difficulty: 5, kp: ['根据对方接发球站位动态切换 Stack'], remedialFocus: '避免换位犹豫漏中路',
    plan60: {
      goal: '高阶 Stack 攻防变化', warmup: '激活 8 分', microTalk: '叠位原则',
      drills: [{ title: '发抢+叠位实操', ballsPerMin: 18, sets: '4组×10球', note: '高速衔接' }],
      game: '高阶计分对抗', wrapup: '总结'
    }
  });

  const saved = await req('PUT', '/api/v1/v3/curriculum/config', nextCfg);
  assert.equal(saved.status, 200);

  // 林小满实时列表已自动出现 H01=0，而她的基线快照版本依然冻结为 2.2.0 且只含当时 34 模块！
  const rptA = await req('GET', `/api/v1/v3/students/${stuAId}`);
  assert.equal(rptA.data.liveAssessment.modules.length, 35);
  assert.equal(rptA.data.liveAssessment.modules.find(m => m.code === 'H01').score, 0);
  const oldBase = rptA.data.snapshots.find(s => s.id === baselineSnapId);
  assert.equal(oldBase.curriculumVersion, '2.2.0');
  assert.equal(oldBase.modules.length, 34);

  // 恢复默认大纲
  const rst = await req('POST', '/api/v1/v3/curriculum/config/reset', {});
  assert.equal(rst.status, 200);
  assert.equal(rst.data.config.modules.length, 34);
});
