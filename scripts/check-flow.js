/* P7 流程自检：课程包 → 大纲 → 备课 → 执行 → 点评
   在 VM 里跑真实前端脚本，用一个「按选择器缓存」的假 DOM，能读回 innerHTML 做断言。
   覆盖：大纲引擎不变量、执行条出现/消失、执行按钮文案、今日视图、课程包列表、点评弹窗字段。 */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf8');
const code = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1] +
  '\n;globalThis.__X={state,buildPlan,renderPlanHTML,renderExecBar,renderEnroll,renderTodayBoard,renderLesson,prepLesson,execInlineHTML,outlineTypeName,packageName,ENR_STATE,defaultState,planForSession,reviewModal,refreshState};';

const nodes = new Map();
function el(sel) {
  const e = {
    _sel: sel, innerHTML: '', textContent: '', value: '', hidden: false, title: '', disabled: false,
    dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, getAttribute() { return null; }, appendChild() {}, remove() {},
    addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return el(sel + ' >'); },
    click() {}, focus() {}, closest() { return null; }, files: []
  };
  return e;
}
function q(sel) {
  if (!nodes.has(sel)) nodes.set(sel, el(sel));
  return nodes.get(sel);
}
const doc = {
  body: el('body'), documentElement: el('html'),
  querySelector(sel) { return q(sel); },
  querySelectorAll() { return []; },
  addEventListener() {}, createElement() { return el('created'); }, dispatchEvent() {},
  activeElement: { tagName: 'BODY' }
};
const cache = {};
const store = { getItem: k => (k in cache ? cache[k] : null), setItem: (k, v) => { cache[k] = String(v); }, removeItem: k => { delete cache[k]; } };
const ctx = {
  console, document: doc, localStorage: store, navigator: {},
  setTimeout: (f) => { if (f) f(); return 1; }, clearTimeout() {},
  Date, Math, JSON, Number, String, Array, Object, Set, Map, isFinite, parseInt, parseFloat,
  Promise, RegExp, Error, Blob: class {}, URL: { createObjectURL: () => '', revokeObjectURL() {} },
  CustomEvent: class {}, confirm: () => false, location: { reload() {} }
};
ctx.window = ctx; ctx.globalThis = ctx; ctx.window.PKB_API = undefined;
vm.createContext(ctx);
try { vm.runInContext(code, ctx, { filename: 'index.inline.js' }); }
catch (e) { console.error('RUNTIME FAIL:', e.message, '\n', e.stack.split('\n').slice(0, 4).join('\n')); process.exit(1); }

const X = ctx.__X;
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log('  FAIL:', name, extra === undefined ? '' : extra); } };

/* ---------- 1. 大纲引擎不变量 ---------- */
const engine = require('../backend/src/services/outline-engine');
const diff = require('../database/seeds/curriculum-difficulty.json');

ok('难度表 24 单元齐全', diff.units.length === 24 && diff.units.every(u => u.difficulty >= 1 && u.difficulty <= 5));
ok('难度表声明「非官方校准」', /未经实验校准|教练经验/.test(diff.calibrationNote));
ok('难度表给出缺失模块（单打 / 间隔复习 / 失败预案）', diff.missingCoverage.length === 3 && diff.missingCoverage.some(m => /单打/.test(m.name)));

function outline(cfg) {
  return engine.buildOutline(Object.assign({ difficulty: diff, startDate: '2026-11-18', lessonsPerWeek: 2 }, cfg));
}
const o10 = outline({ totalLessons: 10, startStage: 1, techLevel: 1, fitLevel: 2 });
ok('10 节课 → 正好排 10 节', o10.rows.length === 10, o10.rows.length);
ok('每节都有日期与分钟', o10.rows.every(r => /^\d{4}-\d{2}-\d{2}$/.test(r.planned_date) && r.minutes === 90));
ok('dates 严格递增', o10.rows.every((r, i) => i === 0 || r.planned_date > o10.rows[i - 1].planned_date));
ok('每周 2 次 → 间隔 3-4 天', (() => {
  const d = (a, b) => (new Date(b) - new Date(a)) / 86400000;
  return o10.rows.slice(0, 4).every((r, i) => i === 0 || d(o10.rows[i - 1].planned_date, r.planned_date) >= 3);
})());
ok('课次课号在 1-48 内', o10.rows.every(r => r.lesson_no >= 1 && r.lesson_no <= 48));
ok('第一节一定是 A 新授', o10.rows[0].lesson_type === 'A');
ok('同一单元内 A 在 B 之前', (() => {
  const byUnit = {};
  for (const r of o10.rows) { (byUnit[r.unit_no] = byUnit[r.unit_no] || []).push(r.lesson_type); }
  return Object.values(byUnit).every(list => list.indexOf('A') === 0 && list.filter(t => t === 'A').length === 1);
})());
ok('购买 10 节 → 提示未覆盖完 24 单元', o10.truncated === true && /不足以覆盖/.test(o10.truncatedReason));

const o48 = outline({ totalLessons: 48, startStage: 1, techLevel: 3, fitLevel: 3 });
ok('48 节仍不足以覆盖全部 24 单元（本次审核的核心发现）', o48.truncated === true, '覆盖到 U' + o48.rows[o48.rows.length - 1].unit_no);
const o56 = outline({ totalLessons: 56, startStage: 1, techLevel: 3, fitLevel: 3 });
ok('56 节可覆盖到第 24 单元', o56.truncated === false);

const senior = outline({ totalLessons: 12, startStage: 1, techLevel: 2, fitLevel: 2, ageGroup: 'senior', minutes: 60 });
const adult12 = outline({ totalLessons: 12, startStage: 1, techLevel: 2, fitLevel: 2 });
ok('常青 / 60 分钟单节剂量更低 → 需要的课次不少于成人 90 分钟', senior.byUnit[0].lessonsNeeded >= adult12.byUnit[0].lessonsNeeded);
ok('单节剂量随技术等级增加', engine.repsPerLesson(5, 3, 'adult', 90) > engine.repsPerLesson(1, 3, 'adult', 90));
ok('60 分钟剂量低于 90 分钟', engine.repsPerLesson(3, 3, 'adult', 60) < engine.repsPerLesson(3, 3, 'adult', 90));
ok('常青剂量低于成人', engine.repsPerLesson(3, 3, 'senior') < engine.repsPerLesson(3, 3, 'adult'));

const diffUnit = engine.lessonsForUnit(diff.units.find(u => u.u === 14), { techLevel: 3, fitLevel: 3, ageGroup: 'adult', minutes: 90 });
ok('9 个并列新授点的 U14 至少拆 3 课（单课上限 3 个）', diffUnit.lessonsNeeded >= 3, diffUnit.lessonsNeeded);
ok('难度不是靠多讲一遍解决：给出 homeworkReps 而不是无限加课次', diffUnit.homeworkReps > 0 && diffUnit.lessonsNeeded <= 4);

const fixed = outline({ totalLessons: 10, startStage: 1, techLevel: 1, fitLevel: 2, paceMode: 'fixed' });
ok('固定节奏不排 R 补强课', fixed.rows.every(r => r.lesson_type !== 'R'));
ok('固定节奏与自适应在同样课数下覆盖单元不同', fixed.rows[fixed.rows.length - 1].unit_no > o10.rows[o10.rows.length - 1].unit_no);

/* ---------- 2. 未达标 → 下一节调整 ---------- */
const adv = engine.nextLessonAdvice({ rows: o10.rows.map(r => ({ seq: r.seq, unit_no: r.unit_no, lesson_no: r.lesson_no, unitNo: r.unit_no, lessonNo: r.lesson_no })), paceMode: 'adaptive' }, 1, '部分达标');
ok('自适应：部分达标建议插入 R 补强', adv.action === 'insert_r' && /补强/.test(adv.text));
ok('插入 R 时提示「其余课时顺延」', /顺延/.test(adv.text));
const advFail = engine.nextLessonAdvice({ rows: o10.rows, paceMode: 'adaptive' }, 1, '未达标');
ok('未达标：重复同单元并降难度', advFail.action === 'repeat' && /下调一档/.test(advFail.text));
const advFixed = engine.nextLessonAdvice({ rows: o10.rows, paceMode: 'fixed' }, 1, '未达标');
ok('固定节奏：不插课，只在下节前 5 分钟复习', advFixed.action === 'hold' && /不延长课时/.test(advFixed.text));
const advPass = engine.nextLessonAdvice({ rows: o10.rows, paceMode: 'adaptive' }, 1, '达标');
ok('达标：直接进下一节', advPass.action === 'keep' && /第 2 节/.test(advPass.text));

/* ---------- 3. 前端：执行动作是否显式存在 ---------- */
const students = [{ id: 'S1', name: '测试甲', age: 'adult', stage: 1, used: 0, total: 48, techScore: 3, fitScore: 3, pkLevel: 3, racketBase: 0, goal: '技术晋级', injury: '', status: '在训' }];
vm.runInContext('state.students = ' + JSON.stringify(students) + ';', ctx);

const form = { studentIds: ['S1'], lesson: 13, minutes: 90, age: 'adult', size: 'solo', date: '2026-11-18', fitMode: 'auto', focus: 'tech', goal: '技术晋级' };
const plan = X.buildPlan(form);

X.state.ui.execCtx = { enrollmentId: 'E1', outlineLessonId: 'OL1', studentId: 'S1', lessonNo: 13, minutes: 90, seq: 4, unitNo: 7, lessonType: 'A', planId: null };
const withExec = X.renderPlanHTML(plan);
ok('教案预览出现「执行此计划 →」', /执行此计划 →/.test(withExec));
ok('教案头部标出「课程包 · 第 4 节」上下文徽章', /课程包 · 第 4 节/.test(withExec));
ok('执行区说明会跳到本次课并等待点评', /本次课/.test(withExec) && /点评/.test(withExec));
ok('执行区标出「来自课程大纲 第 4 节」', /第 4 节/.test(withExec));
ok('执行区给出取消按钮（不会强迫执行）', /data-act="cancel-exec"/.test(withExec));

X.state.ui.execCtx = null;
const noExec = X.renderPlanHTML(plan);
ok('没有大纲上下文时不出现执行按钮（避免无主教案）', !/执行此计划/.test(noExec));

X.state.ui.execCtx = { enrollmentId: 'E1', outlineLessonId: 'OL1', studentId: 'S1', lessonNo: 13, minutes: 90, seq: 4, unitNo: 7, lessonType: 'A', planId: null };
X.state.ui.lastPlan = plan;
X.renderExecBar();
ok('备课页顶部执行条渲染出主按钮', /执行此计划 →/.test(q('#execBar').innerHTML));
ok('执行条说明右侧是教案预览', /教案预览/.test(q('#execBar').innerHTML));

/* 执行条：未生成教案时按钮禁用（防止点了却写不出教案） */
X.state.ui.lastPlan = null;
X.renderExecBar();
ok('未生成教案时执行按钮为 disabled', /id="execBtn" data-act="execute-plan" disabled/.test(q('#execBar').innerHTML), q('#execBar').innerHTML.slice(0, 140));

/* ---------- 4. 课程包页渲染 ---------- */
X.state.ui.lastPlan = plan;
X.state.ui.execCtx = null;
X.state.enrollments = [{
  id: 'E1', studentId: 'S1', studentName: '测试甲', packageType: 'solo', totalLessons: 10, usedLessons: 1,
  lessonsPerWeek: 2, minutesPerLesson: 90, startDate: '2026-11-18', paceMode: 'adaptive', status: 'active', goal: '技术晋级',
  outline: [
    { id: 'OL1', seq: 1, unitNo: 1, lessonNo: 1, lessonType: 'A', plannedDate: '2026-11-18', minutes: 90, status: 'reviewed', sessionId: 'R1' },
    { id: 'OL2', seq: 2, unitNo: 1, lessonNo: 2, lessonType: 'B', plannedDate: '2026-11-22', minutes: 90, status: 'taught', sessionId: 'R2' },
    { id: 'OL3', seq: 3, unitNo: 2, lessonNo: 3, lessonType: 'A', plannedDate: '2026-11-25', minutes: 90, status: 'planned' }
  ]
}];
X.state.ui.enrollId = 'E1';
X.renderEnroll();
const enrollHTML = q('#enrollOutput').innerHTML;
ok('课程包列表显示学员与进度', /测试甲/.test(enrollHTML) && /已上 2\/3/.test(enrollHTML));
ok('大纲表逐节显示状态', /已点评/.test(enrollHTML) && /待点评/.test(enrollHTML) && /待上课/.test(enrollHTML));
ok('待上课那节给「备课」按钮', /data-act="prep-lesson"/.test(enrollHTML));
ok('有未点评课次时给醒目提醒', /节课还没点评/.test(enrollHTML) && /现在点评/.test(enrollHTML));
ok('标注下一节课是哪一节', /下一节：第 3 节/.test(enrollHTML));

/* ---------- 5. 今日视图 ---------- */
X.renderTodayBoard();
const todayHTML = q('#todayBoard').innerHTML;
ok('今日视图列出今天要上的课', /今天要上的课/.test(todayHTML));
ok('今日视图有待点评区', /待点评/.test(todayHTML));
ok('今日视图给课程包入口', /data-go="enroll"/.test(todayHTML));

/* ---------- 6. 本次课页 + 点评弹窗 ---------- */
X.state.sessions = [{
  id: 'R2', studentId: 'S1', studentName: '测试甲', lesson: 2, minutes: 90, date: '2026-11-22',
  attend: '出勤', judge: '部分达标', rpe: 5, note: '拍面稳定', reviewStatus: 'pending', enrollmentId: 'E1', outlineLessonId: 'OL2'
}];
X.state.ui.sessionId = 'R2';
X.state.ui.adjust = '已把第 3 节改为第 1 单元补强课（R）';
X.renderLesson();
const lessonHTML = q('#lessonOutput').innerHTML;
const barHTML = q('#lessonActionBar').innerHTML;
ok('本次课页显示教案全文（照着带课）', /当课次技术拆解/.test(lessonHTML));
ok('本次课页有「点评本次课」按钮', /点评本次课/.test(barHTML));
ok('本次课页回显大纲调整说明', /补强课/.test(barHTML));

X.reviewModal('R2');
const modalHTML = q('#modalRoot').innerHTML;
ok('点评弹窗含 3 个要点勾选', (modalHTML.match(/data-jv="kp\d"/g) || []).length === 3);
ok('点评弹窗含总体判据 / 出勤 / RPE', /rvJudge/.test(modalHTML) && /rvAttend/.test(modalHTML) && /rvRpe/.test(modalHTML));
ok('点评弹窗含作业与下节重点', /rvHw/.test(modalHTML) && /rvNext/.test(modalHTML));
ok('点评弹窗说明「未达标会把下一节改成补强课」', /补强课/.test(modalHTML));
ok('点评弹窗保存按钮指向 save-review', /data-act="save-review"/.test(modalHTML));

/* 已点评的课次：按钮变为「修改点评」，并显示点评汇总 */
X.state.sessions[0].reviewStatus = 'done';
X.state.sessions[0].reviewedAt = '2026-11-22T10:00:00Z';
X.state.sessions[0].judgeVals = { kp1: true, kp2: false };
X.state.sessions[0].homework = '对墙 30×2';
X.renderLesson();
ok('已点评 → 显示「修改点评」', /修改点评/.test(q('#lessonActionBar').innerHTML));
ok('已点评 → 显示点评汇总与要点达成', /本次课点评/.test(q('#lessonOutput').innerHTML) && /达标/.test(q('#lessonOutput').innerHTML));

/* ---------- 7. 导航与命名 ---------- */
ok('导航含 今日 / 课程包 / 备课（不再叫「计划生成」）', /data-nav="today"/.test(html) && /data-nav="enroll"/.test(html) && />备课</.test(html));
ok('快捷键提示与视图顺序一致（1-8）', /<span class="key">3<\/span>/.test(html) && /<span class="key">8<\/span>/.test(html));
ok('总览「使用路径」已是新流程', /执行此计划/.test(html) && /课程包 → 登记/.test(html));

/* ---------- 8. 登录不再反复弹窗（api.js 的行为契约） ---------- */
const apiSrc = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'api.js'), 'utf8');
const idxSrc = html;

ok('401 先静默续期，不直接弹窗', /refreshToken\(\)/.test(apiSrc) && /const renewed = await refreshToken\(\)/.test(apiSrc));
ok('只有前台交互才弹登录框', /interactive = opts\.interactive === true/.test(apiSrc) && /if \(interactive && !autoPromptDisabled\)/.test(apiSrc));
ok('点过「离线继续」后不再自动弹框', /autoPromptDisabled = true/.test(apiSrc) && /autoPromptDisabled = false/.test(apiSrc));
ok('后台同步不标记 interactive', (() => {
  const m = apiSrc.match(/request\('\/state', \{[\s\S]{0,120}?\}\)/);
  return m && !/interactive: true/.test(m[0]);
})());
ok('启动拉取后台续期、失败静默', /await ensureFreshToken\(\)/.test(apiSrc) && /bootstrap/.test(apiSrc));
ok('续期失败置 sessionExpired，不再反复弹窗', /sessionExpired = true/.test(apiSrc));
ok('存储不可用时降级且不崩溃', /pickStorage\('localStorage'\)/.test(apiSrc) && /pickStorage\('sessionStorage'\)/.test(apiSrc) && /storageMode/.test(apiSrc));
ok('令牌带到期时间，可判断剩余时长', /EXP_KEY/.test(apiSrc) && /minutesLeft/.test(apiSrc));
ok('页面可见时主动续期', /visibilitychange/.test(apiSrc) && /ensureFreshToken/.test(apiSrc));
ok('登录成功后记录 expires_in', /setToken\(r\.token, r\.expires_in\)/.test(apiSrc));

// 界面层：过期提示条 + 重新登录入口
ok('界面有会话过期提示条容器', /id="sessionBanner"/.test(idxSrc));
ok('提示条说明「数据没丢，登录后继续同步」', /本机数据仍在|本机数据没有丢/.test(html));
ok('提示条提供「重新登录」按钮', /data-act="relogin"/.test(html));
ok('过期时不再用弹窗打断：relogin 才调 login', /act==='relogin'.*PKB_API\.login/.test(html));
ok('过期弹窗文案说明原因（不再让人困惑）', /会话已过期，请重新登录/.test(apiSrc));

// 服务端契约
const config = require('../backend/src/config');
ok('令牌默认 12 小时（不是 15 分钟）', config.jwtTtlSeconds === 43200, config.jwtTtlSeconds);
ok('续期宽限期 >= 10 分钟', config.jwtRefreshGraceSeconds >= 600, config.jwtRefreshGraceSeconds);

// R 补强课端到端：prepLesson → nextLessonLabel + R 课教案 + 提取未达标判据进点评弹窗
X.state.enrollments = [{
  id: 'E-RFLOW', studentId: 'S1', studentName: '测试甲', packageType: 'solo', totalLessons: 4, usedLessons: 1,
  lessonsPerWeek: 2, minutesPerLesson: 90, startDate: '2026-11-18', paceMode: 'adaptive', status: 'active', goal: '技术晋级',
  outline: [
    { id: 'OLR1', seq: 1, unitNo: 2, lessonNo: 4, lessonType: 'B', plannedDate: '2026-11-18', minutes: 90, status: 'reviewed', sessionId: 'RR1' },
    { id: 'OLR2', seq: 2, unitNo: 2, lessonNo: 4, lessonType: 'R', plannedDate: '2026-11-21', minutes: 90, status: 'planned' },
    { id: 'OLR3', seq: 3, unitNo: 3, lessonNo: 5, lessonType: 'A', plannedDate: '2026-11-25', minutes: 90, status: 'planned' }
  ]
}];
X.state.sessions = [
  { id: 'RR1', studentId: 'S1', studentName: '测试甲', lesson: 4, minutes: 90, date: '2026-11-18',
    attend: '出勤', judge: '部分达标', reviewStatus: 'done', enrollmentId: 'E-RFLOW', outlineLessonId: 'OLR1',
    judgeVals: { kp1: true, kp2: false, kp3: false } }
];
X.prepLesson('E-RFLOW', 'OLR2');
ok('prepLesson 对 R 课写入大纲下一节提示（第 3 节）', !!X.state.ui.execCtx && /大纲第 3 节/.test(X.state.ui.execCtx.nextLessonLabel));
const rPlan = X.buildPlan(X.state.ui.planForm);
ok('prepLesson 生成的 R 课教案已切换为补强版且不含 ④ 体能段', !!rPlan && rPlan.lessonType === 'R' && /补强/.test(rPlan.unit.tech) && rPlan.hasFit === false);
ok('R 课备课预览已提取上节未达标的两条判据', rPlan.unit.kp.split('|').length === 2 && !/肩转过来/.test(rPlan.unit.kp), rPlan.unit.kp);
ok('R 课预告下一节读自大纲而非 +1 猜数', /大纲第 3 节/.test(rPlan.nextLabel));
X.state.enrollments[0].outline[1].status = 'taught';
X.state.enrollments[0].outline[1].sessionId = 'RR2';
X.state.sessions.push({ id: 'RR2', studentId: 'S1', studentName: '测试甲', lesson: 4, minutes: 90, date: '2026-11-21', attend: '出勤', judge: '部分达标', reviewStatus: 'pending', enrollmentId: 'E-RFLOW', outlineLessonId: 'OLR2' });
X.reviewModal('RR2');
ok('R 课点评弹窗只显示上节未达标的 2 条复测判据', (q('#modalRoot').innerHTML.match(/data-jv="kp\d"/g) || []).length === 2 && /复测判据/.test(q('#modalRoot').innerHTML));

console.log(`[check:flow] pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
