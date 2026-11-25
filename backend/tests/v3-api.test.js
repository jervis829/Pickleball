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

test('V3-08 代理覆盖或剥离 Authorization 头时，X-PKB-Session / X-PKB-Auth 与 HttpOnly Cookie 仍可正常认证与续期', async () => {
  // 0) 静态资源带 Cache-Control: no-store，避免反代或浏览器缓存旧 api.js
  const jsRes = await fetch(base + '/api.js?v=3.0.3');
  assert.equal(jsRes.status, 200);
  assert.equal(jsRes.headers.get('cache-control'), 'no-store');

  // 1) HTTPS 预览域名下登录应下发 SameSite=None; Secure; Partitioned Cookie（即使未显式传 X-Forwarded-Proto）
  const loginRes = await fetch(base + '/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://8787-demo.e2b.app', 'x-forwarded-host': '8787-demo.e2b.app' },
    body: JSON.stringify({ username: 'admin', password: process.env.ADMIN_PASSWORD })
  });
  assert.equal(loginRes.status, 200);
  const setCookie = loginRes.headers.get('set-cookie') || '';
  assert.match(setCookie, /pkb_token=/);
  assert.match(setCookie, /SameSite=None/);
  assert.match(setCookie, /Partitioned/);
  const loginJson = await loginRes.json();
  const tk = loginJson.data.token;

  // 2) 模拟反向代理把 Authorization 覆盖成无效值，但保留 X-PKB-Session / X-PKB-Auth
  const r1 = await fetch(base + '/api/v1/v3/students', {
    headers: {
      authorization: 'Bearer invalid-gateway-token',
      'x-pkb-session': tk
    }
  });
  assert.equal(r1.status, 200);

  const r1b = await fetch(base + '/api/v1/v3/students', {
    headers: {
      authorization: 'Bearer invalid-gateway-token',
      'x-pkb-auth': 'Bearer ' + tk
    }
  });
  assert.equal(r1b.status, 200);

  // 3) 模拟反向代理完全剥离 Authorization，只保留 Cookie
  const cookiePair = setCookie.split(';')[0];
  const r2 = await fetch(base + '/api/v1/v3/students', {
    headers: { cookie: cookiePair }
  });
  assert.equal(r2.status, 200);

  // 4) refresh 同样兼容 X-PKB-Session 与 X-PKB-Auth
  const r3 = await fetch(base + '/api/v1/auth/refresh', {
    method: 'POST',
    headers: { 'x-pkb-session': tk }
  });
  assert.equal(r3.status, 200);
});

test('V3-09 60分钟教案模板字段映射完整：warmupFocus/explainFocus/drills({balls})/play/hw 全部完整渲染', async () => {
  const lesDetail = await req('GET', `/api/v1/v3/plans/${planId}/lessons/${firstLessonId}`);
  assert.equal(lesDetail.status, 200);
  const pc = lesDetail.data.planContent;
  assert.ok(pc.segments[0].content && pc.segments[0].content.includes('步伐重点'), '热身段应包含 warmupFocus 与 footworkFocus');
  assert.ok(pc.segments[1].content && pc.segments[1].content.includes('常见易错'), '精讲段应包含 explainFocus 与纠错');
  assert.ok(Array.isArray(pc.segments[2].drills) && pc.segments[2].drills.length >= 2);
  for (const d of pc.segments[2].drills) {
    assert.ok(d.title && d.note && !d.note.includes('{balls}'), 'drills 应解析为结构化练习并替换 {balls}');
  }
  assert.ok(pc.segments[3].content && pc.segments[3].content.length > 5, '实战对抗段 play 不应为空');
  assert.ok(pc.segments[4].content && pc.segments[4].content.length > 5, '课后总结段 hw 不应为空');
});

test('V3-10 业务边界与数据一致性：防重复扣课、防重排重复ID、体能边界与非法日期校验', async () => {
  // 1) 同一课次提交重复 studentId 必须被拒绝（防止双倍扣课时+重复快照）
  const dupRev = await req('POST', `/api/v1/v3/plans/${planId}/lessons/${secondLessonId}/complete`, {
    completedDate: '2026-11-19',
    studentReviews: [
      { studentId: stuAId, attend: 'present', score: 2 },
      { studentId: stuAId, attend: 'present', score: 3 }
    ]
  });
  assert.equal(dupRev.status, 422);
  assert.equal(dupRev.payload.error.code, 'DUPLICATE_STUDENT_REVIEW');

  // 2) reorderPlanLessons 包含重复 lessonId 必须拒绝
  const p = await req('GET', `/api/v1/v3/plans/${planId}`);
  const ids = p.data.lessons.map(l => l.id);
  const dupIds = [ids[0], ids[1], ids[1], ...ids.slice(3)];
  const dupReo = await req('POST', `/api/v1/v3/plans/${planId}/reorder`, { orderedLessonIds: dupIds });
  assert.equal(dupReo.status, 422);

  // 3) 重复自定义学员 ID 返回 409 而非 500
  const dupStu = await req('POST', '/api/v1/v3/students', { id: stuAId, name: '冲突测试' });
  assert.equal(dupStu.status, 409);

  // 4) 体能负值 / 越界值 / 非法日期均返回 422
  const badFit1 = await req('POST', `/api/v1/v3/students/${stuAId}/fitness`, {
    testDate: '2026-11-18', gender: 'female', ageGroup: 'a18', raw: { power: { value: -5 } }
  });
  assert.equal(badFit1.status, 422);
  const badFit2 = await req('POST', `/api/v1/v3/students/${stuAId}/fitness`, {
    testDate: '2026-11-18', gender: 'female', ageGroup: 'a18', raw: { reaction: { value: 99 } }
  });
  assert.equal(badFit2.status, 422);
  const badFitDate = await req('POST', `/api/v1/v3/students/${stuAId}/fitness`, {
    testDate: 'not-a-date', gender: 'female', ageGroup: 'a18', raw: { reaction: { value: 4 } }
  });
  assert.equal(badFitDate.status, 422);

  // 5) 计划非法日期拒绝
  const badPlanDate = await req('POST', '/api/v1/v3/plans', {
    studentIds: [stuAId], totalLessons: 4, startDate: '2026-99-99'
  });
  assert.equal(badPlanDate.status, 422);
});

test('V3-11 系统安全防护：畸形URI/Cookie防崩、隐藏文件拦截、禁用URL令牌、防XSS/原型污染', async () => {
  // 1) 畸形百分号 URL 不崩溃进程，优雅返回 400
  const badUri = await fetch(base + '/api/v1/%E0%A4%A');
  assert.equal(badUri.status, 400);

  // 2) 畸形 Cookie 不崩溃进程
  const badCk = await fetch(base + '/api/v1/v3/students', { headers: { cookie: 'pkb_token=%ZZ%E0' } });
  assert.equal(badCk.status, 401);

  // 3) 隐藏路径 / 点文件拦截
  const dotRes = await fetch(base + '/.env');
  assert.equal(dotRes.status, 403);

  // 4) 禁止 URL query ?token= 传递 JWT
  const qTok = await fetch(base + '/api/v1/v3/students?token=' + encodeURIComponent(token));
  assert.equal(qTok.status, 401);

  // 5) 课程配置拒绝包含 XSS 字符的模块编号与原型污染键名
  const cfgRes = await req('GET', '/api/v1/v3/curriculum/config');
  const evilCfg = JSON.parse(JSON.stringify(cfgRes.data));
  evilCfg.modules.push({
    code: '<script>', seq: 99, track: 'basic', categoryId: 'C1', title: 'xss', difficulty: 1,
    kp: ['test'], plan60: { drills: ['d1'] }
  });
  const evilSave = await req('PUT', '/api/v1/v3/curriculum/config', evilCfg);
  assert.equal(evilSave.status, 422);

  const protoCfg = JSON.parse(JSON.stringify(cfgRes.data));
  protoCfg.tracks.push({ id: 'constructor', name: 'bad', order: 9, mode: 'elective' });
  const protoSave = await req('PUT', '/api/v1/v3/curriculum/config', protoCfg);
  assert.equal(protoSave.status, 422);
});

test('V3-12 改密立即吊销旧令牌 + 登录连续失败触发限流防护', async () => {
  const newPass = 'v3-rotated-password-456';
  const ch = await req('POST', '/api/v1/auth/change-password', {
    old_password: process.env.ADMIN_PASSWORD,
    new_password: newPass
  });
  assert.equal(ch.status, 200);

  // 旧令牌必须立即失效（普通接口与续期接口均拒绝）
  const oldAccess = await req('GET', '/api/v1/v3/students');
  assert.equal(oldAccess.status, 401);
  const oldRefresh = await req('POST', '/api/v1/auth/refresh', {});
  assert.equal(oldRefresh.status, 401);
  assert.equal(oldRefresh.payload.error.code, 'TOKEN_REVOKED');

  // 使用新密码登录并恢复原密码
  const loginNew = await req('POST', '/api/v1/auth/login', { username: 'admin', password: newPass });
  assert.equal(loginNew.status, 200);
  token = loginNew.data.token;
  const restore = await req('POST', '/api/v1/auth/change-password', {
    old_password: newPass,
    new_password: process.env.ADMIN_PASSWORD
  });
  assert.equal(restore.status, 200);
  const loginBack = await req('POST', '/api/v1/auth/login', { username: 'admin', password: process.env.ADMIN_PASSWORD });
  assert.equal(loginBack.status, 200);
  token = loginBack.data.token;

  // 验证连续错误登录触发 429 限流（用独立测试账号名避免影响 admin 测试流）
  for (let i = 0; i < 10; i++) {
    const r = await req('POST', '/api/v1/auth/login', { username: 'brute_probe_user', password: 'wrong-password' });
    assert.equal(r.status, 401);
  }
  const locked = await req('POST', '/api/v1/auth/login', { username: 'brute_probe_user', password: 'wrong-password' });
  assert.equal(locked.status, 429);
  assert.equal(locked.payload.error.code, 'RATE_LIMITED');
});

test('V3-13 报告文档生成引擎：标准 PDF 1.4 字节流结构校验 + 技术/体能分享网页 XSS 转义', async () => {
  const reportMod = require('../../frontend/report-pdf.js');
  const rptA = await req('GET', `/api/v1/v3/students/${stuAId}`);
  assert.equal(rptA.status, 200);

  // 1) 技术报告模型与独立 HTML（注入恶意脚本测试转义）
  const xssRpt = JSON.parse(JSON.stringify(rptA.data));
  xssRpt.student.name = '林小满<script>alert(1)</script>';
  const techHtml = reportMod.buildTechnicalReportHtml({ report: xssRpt, triggerLabel: '测试快照', radarSvg: '<svg></svg>' });
  assert.match(techHtml, /技术类别能力评估报告/);
  assert.match(techHtml, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.equal(techHtml.includes('<script>alert(1)</script>'), false);

  // 2) 6维体能报告模型与独立 HTML
  const fitHtml = reportMod.buildFitnessReportHtml({ report: xssRpt, ageGroupName: '18–34 青年', radarSvg: '<svg></svg>' });
  assert.match(fitHtml, /6 维零道具体能测评报告/);
  assert.match(fitHtml, /爆发力/);
  assert.equal(fitHtml.includes('<script>alert(1)</script>'), false);

  // 3) PDF 1.4 二进制结构与 xref 精确字节偏移校验（2 页 A4）
  const fakeJpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);
  const pdfBytes = reportMod.buildPdfFromJpegPages([
    { bytes: fakeJpg, widthPx: 1488, heightPx: 2105 },
    { bytes: fakeJpg, widthPx: 1488, heightPx: 2105 }
  ]);
  const pdfText = Buffer.from(pdfBytes).toString('latin1');
  assert.equal(pdfText.startsWith('%PDF-1.4\n'), true);
  assert.match(pdfText, /\/Count 2/);
  assert.match(pdfText, /\/MediaBox \[0 0 595\.28 841\.89\]/);
  assert.match(pdfText, /%%EOF\s*$/);

  // 校验 xref 中记录的每个对象字节偏移量均精确指向 "<id> 0 obj"
  const xrefMatch = pdfText.match(/xref\n0 (\d+)\n([\s\S]*?)trailer/);
  assert.ok(xrefMatch);
  const objCount = Number(xrefMatch[1]);
  assert.equal(objCount, 9); // 0 + 1(Catalog) + 2(Pages) + 2*3(Page+Img+Content)
  const lines = xrefMatch[2].trim().split('\n');
  for (let id = 1; id < objCount; id++) {
    const off = Number(lines[id].slice(0, 10));
    const slice = pdfText.slice(off, off + 16);
    assert.equal(slice.startsWith(`${id} 0 obj\n`), true, `对象 ${id} xref 偏移未对齐: ${JSON.stringify(slice)}`);
  }
});


