/* v4.1 前端生成引擎自检：模拟 DOM 执行真实 <script>，验证教案输出 */
const fs = require('fs'), vm = require('vm');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf8');
const code = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1] + '\n;globalThis.__X={UNITS,LESSONS,SEGMENTS,PARAMS,GOALS,SCORE_MATRIX,TECH_A,RACKET_B,FIT_ANCHOR,STAGES,AGE_GROUPS,ZONES,state,fitPreview,fitRadarSVG,fitBarsHTML,fitLevelOf,buildFitnessBridge,FIT_LEVEL_LABEL_LOCAL,REMUNITS,REM_LESSON,lessonFor,dosageFactor,difficultyOf,buildPacing,planExtraHTML,planForSession,refreshLessonOptions,DIFF:()=>DIFF_INDEX,setDiff:(d)=>{window.PKB_DIFFICULTY=d;DIFF_INDEX={};(d.units||[]).forEach(u=>{DIFF_INDEX[Number(u.u)]=u})}};';
if (!code) { console.error('NO SCRIPT'); process.exit(1); }

function el() {
  const e = {
    _v: '', innerHTML: '', textContent: '', value: '', hidden: false, title: '',
    dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, getAttribute() { return null; }, appendChild() {}, remove() {},
    addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return el(); },
    click() {}, focus() {}, closest() { return null; }, files: []
  };
  Object.defineProperty(e, 'disabled', { get() { return false; }, set() {} });
  return e;
}
const cache = {};
const doc = {
  body: el(), documentElement: el(),
  querySelector() { return el(); }, querySelectorAll() { return []; },
  addEventListener() {}, createElement() { return el(); }, dispatchEvent() {},
  activeElement: { tagName: 'BODY' }
};
const store = {
  getItem: k => (k in cache ? cache[k] : null),
  setItem: (k, v) => { cache[k] = String(v); }, removeItem: k => { delete cache[k]; }
};
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
const ok = (name, cond, extra) => { if (cond) { pass++; } else { fail++; console.log('  FAIL:', name, extra || ''); } };

// ---- 结构与数据 ----
ok('JS 语法 + 运行时无异常', true);
ok('SEGMENTS 保留', !!X.SEGMENTS && !!X.SEGMENTS.warm && !!X.SEGMENTS.cool);
ok('UNITS 24 条', Array.isArray(X.UNITS) && X.UNITS.length === 24, X.UNITS && X.UNITS.length);
ok('LESSONS 48 课', X.LESSONS.length === 48);
ok('normalize 保留', typeof ctx.normalize === 'function');
ok('state 保留', !!X.state && Array.isArray(X.state.students));
ok('PARAMS 完整', Object.keys(X.PARAMS).length >= 60, Object.keys(X.PARAMS).length);
ok('评分矩阵 A0×B5 = 3', X.SCORE_MATRIX[0][5] === 3);
ok('5 类目标', X.GOALS.length === 5, X.GOALS.join('/'));
ok('flick 在 U14', /flick/.test(X.UNITS[13].tech + X.UNITS[13].a + X.UNITS[13].b));
ok('roll volley 在 U14', /roll volley/.test(X.UNITS[13].b));
ok('roll dink 在 U13', /roll dink/.test(X.UNITS[12].a));
ok('hands battle 在 U19', /hands battle/.test(X.UNITS[18].tech + X.UNITS[18].b));
ok('shake & bake 在 U23', /shake & bake/.test(X.UNITS[22].a));
ok('middle ball 在 U23', /middle ball/.test(X.UNITS[22].a));
ok('return & crash 在 U17', /return & crash/.test(X.UNITS[16].a));
ok('bounce it 在 U15', /bounce it/.test(X.UNITS[14].tech + X.UNITS[14].b));
ok('两处副本名称一致', !/教学管理中台/.test(html));

// ---- 参数化完整性 ----
const bad = html.match(/\[(?:N|RPE|距离|发球机档位|成功率|重量|阻力色阶|预警课次|预警天数|回收率|低分线|触发分)\]/g) || [];
ok('无方括号占位残留', bad.length === 0, bad.slice(0, 5).join(','));
const keys = new Set([...html.matchAll(/\{p:([A-Za-z0-9_]+)\}/g)].map(m => m[1]));
const undef = [...keys].filter(k => !(k in X.PARAMS));
ok('所有 {p:key} 都有默认值', undef.length === 0, undef.join(','));

// ---- 生成引擎：造学员 ----
function mk(o) { return Object.assign({ id: 'X' + Math.random(), name: '测试', age: 'adult', stage: 1, used: 0, total: 48, techScore: 3, fitScore: 3, pkLevel: 3, racketBase: 0, goal: '技术晋级', injury: '', status: '在训' }, o); }
function gen(students, form, fitnessReports) {
  vm.runInContext('state.students = ' + JSON.stringify(students) + ';', ctx);
  const f = Object.assign({ studentIds: students.map(s => s.id), lesson: 13, minutes: 90, age: 'adult', size: 'small', date: '2026-11-14', fitMode: 'auto', focus: 'tech', goal: '技术晋级' }, form || {});
  const p = ctx.buildPlan(f, undefined, fitnessReports);
  return { p, text: p ? ctx.planText(p) : '' };
}
const base = gen([mk({})]);
const review = ctx.buildTrainingReview(base.p, { available: true, students: [{
  student: { name: '测试学员' },
  matchedWeakSkills: [{ skillKey: 'weak-1', skillName: '正手截击', history: [{ score: 2 }, { score: 1 }] }],
  parkedWeakSkills: [{ skillName: '发球' }],
  masteredSkills: [{ skillName: '反手挑球' }],
  safety: { holdAdditionalLoad: true, caution: true, reasons: ['最近 RPE 偏高'] }
}] });
ok('动态复习只接收本课匹配薄弱项', review.weak.length === 1 && review.weak[0].skillName === '正手截击');
ok('动态复习保留不匹配薄弱项待后续主题', review.parked.length === 1);
ok('稳定掌握不意味着跳课', review.mastered.length === 1);
ok('RPE / 安全信号触发负荷保护', review.safety.holdAdditionalLoad === true);
const dynamicPlan = (() => {
  const students = [mk({ techScore: 5, fitScore: 5, pkLevel: 5 })];
  vm.runInContext('state.students = ' + JSON.stringify(students) + ';', ctx);
  return ctx.buildPlan({ studentIds: [students[0].id], lesson: 13, minutes: 90, age: 'adult', size: 'small', date: '2026-11-14', fitMode: 'auto', goal: '技术晋级' }, {
    available: true, students: [{
      student: { name: '测试学员' },
      matchedWeakSkills: [{ skillKey: 'weak-1', skillName: '正手截击', history: [{ score: 2 }, { score: 1 }] }],
      parkedWeakSkills: [], masteredSkills: [],
      safety: { holdAdditionalLoad: true, caution: true, reasons: ['最近 RPE 偏高'] }
    }]
  });
})();
const drillSegment = dynamicPlan.struct.find(x => x.id === 'drill');
ok('P4 薄弱项复习真正进入③分解练习', dynamicPlan.trainingReview.weak.length === 1);
ok('P4 复习占用③原有前5分钟', ctx.blockTime(drillSegment, 0, dynamicPlan).startsWith((drillSegment.start + 5) + '-'));
ok('P4 复习不改变总课时', dynamicPlan.struct.reduce((a, b) => a + b.end - b.start, 0) === 90);
ok('P4 负荷保护关闭高阶额外加练', dynamicPlan.advanced.length === 0);
ok('P4 负荷保护封顶训练参数倍率', ctx.paramVal('feedBalls', dynamicPlan) <= ctx.paramVal('feedBalls', base.p));
ok('P4 动态复习出现在可视教案中', /动态纠错复习/.test(ctx.renderPlanHTML(dynamicPlan)));

ok('基础教案生成成功', !!base.p);
ok('教案无 {p:} 残留', !/\{p:/.test(base.text));
ok('教案无 [N] 残留', !/\[N\]/.test(base.text));
ok('教案含实数', /[0-9]+\s*球/.test(base.text), base.text.slice(0, 200));
ok('90 分钟段时长合计 90', base.p.struct.reduce((a, b) => a + (b.end - b.start), 0) === 90);
const t60 = gen([mk({})], { minutes: 60 });
ok('60 分钟段时长合计 60', t60.p.struct.reduce((a, b) => a + (b.end - b.start), 0) === 60);
ok('60 分钟教案无 0 长度块', t60.p.struct.every(x => x.end > x.start));
ok('60 分钟要点数变 2', ctx.paramVal('keyPoints', t60.p) === 2);
ok('90 分钟短局 7 分', ctx.paramVal('shortGame', base.p) === 7);
ok('60 分钟短局 4 分', ctx.paramVal('shortGame', t60.p) === 4);

// ---- 分数驱动 ----
const lo = gen([mk({ techScore: 0, fitScore: 0, pkLevel: 0 })]);
const hi = gen([mk({ techScore: 5, fitScore: 5, pkLevel: 5 })]);
ok('技术 0 分球数 < 技术 5 分', ctx.paramVal('feedBalls', lo.p) < ctx.paramVal('feedBalls', hi.p), ctx.paramVal('feedBalls', lo.p) + ' vs ' + ctx.paramVal('feedBalls', hi.p));
ok('体能 0 分自动取消 ④ 段', lo.p.hasFit === false);
ok('体能 5 分组数 > 体能 0 分', ctx.paramVal('strengthSets', hi.p) > ctx.paramVal('strengthSets', lo.p));
ok('技术 5 分触发高阶加练', Array.isArray(hi.p.advanced) && hi.p.advanced.length === 4);
ok('高阶加练进入教案文本', /高阶加练/.test(hi.text));
ok('非 5 分不出现高阶加练', !/高阶加练/.test(base.text));

// ---- 双维评分 / 迁移纠错 ----
const pro = gen([mk({ techScore: 3, fitScore: 5, pkLevel: 0, racketBase: 5 })]);
ok('职业转项触发迁移纠错', pro.p.transfer === true);
ok('迁移纠错进入教案', /挥拍类迁移纠错/.test(pro.text));
ok('职业转项体能分 5', pro.p.fitEff === 5);
ok('职业转项技术分 3', pro.p.techAvg === 3);
ok('体能 5 分不被技术分压制', pro.p.rpeCap === 7);

// ---- 年龄段 ----
const senior = gen([mk({ age: 'senior', techScore: 3, fitScore: 5 })], { age: 'senior' });
ok('常青体能封顶 3', senior.p.fitEff === 3);
ok('常青 RPE 封 4', senior.p.rpeCap === 4 && ctx.paramVal('rpeFitHigh', senior.p) <= 4);
const youth = gen([mk({ age: 'youth' })], { age: 'youth' });
ok('青少年 RPE 封 6', youth.p.rpeCap === 6);
const mixed = gen([mk({ age: 'adult' }), mk({ age: 'senior', fitScore: 1 })], { age: 'mixed' });
ok('混合班取全班最低体能分', mixed.p.fitEff <= 1);

// ---- 目标驱动 ----
const g1 = gen([mk({})], { goal: '技术晋级' });
const g2 = gen([mk({})], { goal: '减脂塑形' });
ok('目标改变段配比', JSON.stringify(g1.p.struct.map(x => x.end - x.start)) !== JSON.stringify(g2.p.struct.map(x => x.end - x.start)));
ok('减脂塑形体能段 30 min', g2.p.struct.find(x => x.id === 'fit') && (g2.p.struct.find(x => x.id === 'fit').end - g2.p.struct.find(x => x.id === 'fit').start) === 30);
ok('各目标段合计 = 90', X.GOALS.every(g => { const x = gen([mk({})], { goal: g }); return x.p.struct.reduce((a, b) => a + (b.end - b.start), 0) === 90; }));
ok('各目标 60 分钟段合计 = 60', X.GOALS.every(g => { const x = gen([mk({})], { goal: g, minutes: 60 }); return x.p.struct.reduce((a, b) => a + (b.end - b.start), 0) === 60; }));
ok('专项补强球数上浮', ctx.paramVal('feedBalls', gen([mk({})], { goal: '专项补强' }).p) > ctx.paramVal('feedBalls', g1.p));

// ---- 分层 / 功能区 ----
const spread = gen([mk({ techScore: 1 }), mk({ techScore: 4 })]);
ok('技术分差 ≥2 出现分层任务', spread.p.notes.some(x => /分层任务/.test(x)));
ok('功能区最多 1 处', (spread.p.venue.filter(x => /可选替代/.test(x)).length <= 1));
ok('全员同一场地声明', spread.p.venue[0].includes('不分组、不分区轮转'));
const goals2 = gen([mk({ goal: '技术晋级' }), mk({ goal: '兴趣体验' })], { goal: '技术晋级' });
ok('目标不一致有提示', goals2.p.notes.some(x => /目标不一致/.test(x)));

// ---- 体能测评 → 教案桥接 ----
const battery = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'database', 'seeds', 'fitness-battery.json'), 'utf8'));
const scoring = require('../backend/src/services/fitness-scoring');
ok('体能测评表 9 项 / 9 维度', battery.items.length === 9 && Object.keys(battery.weights).length === 9);
ok('每项都有分档锚点与安全说明', battery.items.every(i => Array.isArray(i.anchors) && i.anchors.length === 5 && i.safety && i.protocol));
ok('维度权重合计 = 1', Math.abs(Object.values(battery.weights).reduce((a, b) => a + b, 0) - 1) < 1e-9);

// 前端即时预览必须与后端计分完全一致（避免「录入看到的分」和「保存后的分」不一致）
let parity = 0, parityBad = 0;
for (const item of battery.items) {
  for (const ag of battery.ageGroups) {
    for (const sex of ['', 'male', 'female']) {
      for (const raw of [item.code === 'sit_reach' ? -8 : 5, item.code === 'step_hr' ? 120 : 25, item.code === 'agility_5_10_5' ? 6.4 : 18]) {
        for (const vc of [''].concat((item.variants || []).map(v => v.code))) {
          const fe = X.fitPreview(battery, ag.code, sex, item, raw, vc || '');
          let be = null;
          try {
            be = scoring.scoreItem(battery, { itemCode: item.code, rawValue: raw, variantCode: vc || undefined }, { ageGroup: ag, sex: sex || null }).indexValue;
          } catch (e) { be = 'ERR'; }
          parity++;
          const fi = fe ? fe.index : null;
          if (fi === null && be === null) continue;
          if (fi === null || be === null || Math.abs(fi - be) > 0.2) parityBad++;
        }
      }
    }
  }
}
ok('前端即时指数与后端计分一致', parityBad === 0, parity + ' 例中不一致 ' + parityBad);
ok('年龄组下发含 dimensionFactor（否则前端会静默丢失让步）', battery.ageGroups.filter(g => g.code !== 'a18').every(g => g.dimensionFactor && Object.keys(g.dimensionFactor).length === 9));

// 未测不当作 0 分
const partial = scoring.computeReport(battery, {
  age: 30, sex: 'male', results: [
    scoring.scoreItem(battery, { itemCode: 'plank', rawValue: 90 }, { ageGroup: scoring.findAgeGroup(battery, 30), sex: 'male' }),
    scoring.scoreItem(battery, { itemCode: 'sit_reach', rawValue: 10, status: 'aborted' }, { ageGroup: scoring.findAgeGroup(battery, 30), sex: 'male' })
  ]
});
ok('未测维度不计入总分', partial.totalIndex != null && partial.coverage.measured === 1);
ok('中止项不计 0 分', partial.results.find(r => r.itemCode === 'sit_reach').indexValue === null);
ok('缺失项单列 missing', partial.missing.length === 7 && partial.notMeasured.length === 1);

// 雷达图 / 条形图可渲染且无脏值
const svg = X.fitRadarSVG(partial.dimensions);
ok('雷达图 SVG 渲染正常', svg.includes('<polygon') && !/NaN|undefined/.test(svg));
ok('条形图渲染正常', !/NaN|undefined/.test(X.fitBarsHTML(partial.dimensions)));

// 报告 → 教案
const sens = scoring.computeReport(battery, {
  age: 30, sex: 'male', results: battery.items.map(i => scoring.scoreItem(battery, {
    itemCode: i.code, rawValue: i.direction === 'higher' ? i.anchors[0] + 1 : i.anchors[0] - 1
  }, { ageGroup: scoring.findAgeGroup(battery, 30), sex: 'male' }))
});
const fitRec = { available: true, students: [{ assessment: {
  studentId: 'X1', student: { name: '测试' }, testDate: '2026-11-18', ageGroup: { name: '成人 18-39 岁' },
  report: sens, advice: scoring.planAdvice(battery, sens)
} }] };
const withFit = gen([mk({})], {}, fitRec);
ok('体测报告进入教案', withFit.p.fitness && withFit.p.fitness.available === true);
ok('体测报告在教案文本中可见', /体能测评|体测/.test(ctx.planText(withFit.p) + ctx.renderPlanHTML(withFit.p)));
ok('体测不改变课次与时长', withFit.p.lesson.n === base.p.lesson.n && withFit.p.struct.reduce((a, b) => a + b.end - b.start, 0) === 90);
ok('未接入体测时教案不变', base.p.fitness === null && !/体能补强（来自入班体能测评）/.test(base.text));
ok('低分体能触发负荷保护说明', (() => {
  const lowFit = Object.assign({}, sens, { totalIndex: 20, ageGroup: Object.assign({}, sens.ageGroup, { rpeCap: 4 }) });
  const low = gen([mk({})], {}, { available: true, students: [{ assessment: {
    studentId: 'X1', student: { name: '测试' }, testDate: '2026-11-18', report: lowFit,
    advice: scoring.planAdvice(battery, lowFit)
  } }] });
  return low.p && low.p.fitness && low.p.fitness.loadGuard === true && low.p.notes.some(x => /体能负荷保护/.test(x));
})());

// ---- P7 收尾：R 补强课教案 + 难度表驱动剂量 ----
const DIFF = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'database', 'seeds', 'curriculum-difficulty.json'), 'utf8'));
ok('难度表 24 单元齐全', DIFF.units.length === 24);
ok('离线未登录时默认 DIFF_INDEX 已带入 24 单元', Object.keys(X.DIFF()).length === 24 && X.difficultyOf({ lesson: { u: 14 } }).difficulty === 5);
ok('补强课教案 24 条齐全', Array.isArray(X.REMUNITS) && X.REMUNITS.length === 24 && X.REMUNITS.every(r => r.kp && r.drill && /补强/.test(r.tech)));
ok('R 课判据只两三条，不与整单元重复', X.REMUNITS.every(r => r.kp.split('|').length <= 3));

const rLesson = X.lessonFor(19, 'R');
ok('lessonFor(R) 取到补强课模板', !!rLesson && rLesson.type === 'R' && /补强/.test(rLesson.tech), rLesson && rLesson.tech);
// 与后端一致：R 课在 outline_lessons 里的 lesson_no 取同单元的 B 课号（(unit-1)*2+2）
ok('lessonFor(R) 课次号取同单元 B 课号', rLesson.n === 38, rLesson && rLesson.n);
ok('lessonFor(A/B) 与 48 课次一致', X.lessonFor(19, 'A').n === 37 && X.lessonFor(19, 'B').n === 38, [X.lessonFor(19, 'A').n, X.lessonFor(19, 'B').n].join('/'));

function genR(unitNo) {
  vm.runInContext('state.students = ' + JSON.stringify([mk({ techScore: 2, fitScore: 3 })]), ctx);
  const s = JSON.parse(vm.runInContext('JSON.stringify(state.students)', ctx));
  const p = ctx.buildPlan({
    studentIds: [s[0].id], lesson: (unitNo - 1) * 2 + 2, minutes: 90, age: 'adult', size: 'solo',
    date: '2026-11-18', fitMode: 'auto', focus: 'tech', goal: '技术晋级', unitNo, lessonType: 'R'
  }, undefined, undefined);
  return { p, text: p ? ctx.planText(p) + ctx.renderPlanHTML(p) : '' };
}
const r19 = genR(19);
ok('R 课教案可生成', !!r19.p && r19.p.lessonType === 'R');
ok('R 课标题写明「补强」', /补强/.test(r19.p.unit.tech));
ok('R 课不设 ④ 体能段（不新增负荷）', r19.p.hasFit === false && /R 补强课/.test(r19.p.fitReason));
ok('R 课教案无占位残留', !/\{p:|\[N\]/.test(r19.text));
ok('R 课正文说明只复测未达标判据', /不引入新技术点|只练未达标判据/.test(r19.text));
ok('R 课带剂量自检块', !!r19.p.pacing && r19.p.pacing.available);
ok('R 课提示「这是补强课」', r19.p.pacing.warn.some(x => /R 补强课/.test(x)));

ok('R 课不额外放大球数（dosageFactor=1）', X.dosageFactor({ lesson: { u: 13, type: 'R' } }) === 1 && X.dosageFactor({ lesson: { u: 13, type: 'A' } }) === 1.5);
ok('R 课剂量自检标注 0 个新授且不加球数', r19.p.pacing.newPoints === 0 && /0 个新授/.test(r19.text) && /不加球数/.test(r19.text));

// 跨阶备课：Stage 1 学员备 Stage 2 课次不被重置回 Stage 1
vm.runInContext('state.students = ' + JSON.stringify([mk({ id: 'S-STG', stage: 1, used: 0 })]), ctx);
vm.runInContext("state.ui.planForm = { studentIds: ['S-STG'], lesson: 26, minutes: 90, date: '2026-11-18', size: 'solo', age: 'adult', focus: 'tech', fitMode: 'auto', goal: '技术晋级', unitNo: 13, lessonType: 'R' }; state.ui.execCtx = { enrollmentId: 'E1', outlineLessonId: 'OL99', studentId: 'S-STG', lessonNo: 26, minutes: 90, seq: 10, unitNo: 13, lessonType: 'R' };", ctx);
X.refreshLessonOptions();
ok('跨阶大纲备课不被学员 stage 重置回第 1 课', X.state.ui.planForm.lesson === 26, X.state.ui.planForm.lesson);
vm.runInContext('state.ui.execCtx = null;', ctx);

// R 补强课动态提取上节「未达标」判据并展开参数占位
vm.runInContext('state.students = ' + JSON.stringify([mk({ id: 'S-REM', techScore: 2, fitScore: 3 })]), ctx);
vm.runInContext('state.enrollments = ' + JSON.stringify([{ id: 'E-REM', studentId: 'S-REM', packageType: 'solo', goal: '技术晋级', outline: [{ id: 'OL-B', seq: 1, unitNo: 2, lessonNo: 4, lessonType: 'B', sessionId: 'SES-B', status: 'reviewed' }, { id: 'OL-R', seq: 2, unitNo: 2, lessonNo: 4, lessonType: 'R', sessionId: 'SES-R', status: 'planned' }] }]), ctx);
vm.runInContext('state.sessions = ' + JSON.stringify([{ id: 'SES-B', studentId: 'S-REM', lesson: 4, minutes: 90, date: '2026-11-17', enrollmentId: 'E-REM', outlineLessonId: 'OL-B', judge: '部分达标', judgeVals: { kp1: true, kp2: false, kp3: true } }, { id: 'SES-R', studentId: 'S-REM', lesson: 4, minutes: 90, date: '2026-11-18', enrollmentId: 'E-REM', outlineLessonId: 'OL-R', judge: '部分达标', reviewStatus: 'pending' }]), ctx);
const rDyn = X.planForSession(X.state.sessions[1]);
ok('R 课精确提取上节未达标的第 2 条判据并展开实数', !!rDyn && /击球点在身前 \d+ cm/.test(rDyn.unit.kp) && !/拍头低于手腕|肩转过来/.test(rDyn.unit.kp), rDyn && rDyn.unit.kp);
ok('R 课提取判据后无 {p:} 占位残留', !/\{p:/.test(ctx.planText(rDyn) + ctx.renderPlanHTML(rDyn)));

// 难度表驱动剂量：同技术分下，难度 5 的单元球数 > 难度 2 的单元
vm.runInContext('__X.setDiff(' + JSON.stringify(DIFF) + ')', ctx);
function ballsFor(lessonNo) {
  vm.runInContext('state.students = ' + JSON.stringify([mk({ techScore: 3, fitScore: 3, pkLevel: 3 })]), ctx);
  const s = JSON.parse(vm.runInContext('JSON.stringify(state.students)', ctx));
  const p = ctx.buildPlan({ studentIds: [s[0].id], lesson: lessonNo, minutes: 90, age: 'adult', size: 'small', date: '2026-11-18', fitMode: 'auto', focus: 'tech', goal: '技术晋级' }, undefined, undefined);
  return { balls: ctx.paramVal('feedBalls', p), p };
}
const u2 = 2, u5 = 5, u13 = 13;
const bU2 = ballsFor((u2 - 1) * 2 + 1), bU5 = ballsFor((u5 - 1) * 2 + 1), bU13 = ballsFor((u13 - 1) * 2 + 1);
ok('难度 5 单元球数 > 难度 2 单元', bU13.balls > bU2.balls, bU2.balls + ' vs ' + bU13.balls);
ok('难度 5 单元球数 > 难度 4 单元', bU13.balls > bU5.balls, bU5.balls + ' vs ' + bU13.balls);
ok('难度系数落在 0.9-1.5', (() => { const f = [1, 2, 3, 4, 5].map(d => ctx.dosageFactor({ lesson: { u: d } })); return f.every(x => x >= 0.9 && x <= 1.5); })());
ok('球数有 40 球/人 上限', (() => {
  vm.runInContext('state.params = {feedBalls: 100}', ctx);
  const r = ballsFor((u13 - 1) * 2 + 1);
  vm.runInContext('state.params = {}', ctx);
  return r.balls <= 40;
})(), 'cap');
ok('难度表驱动后教案仍无占位残留', !/\{p:/.test(bU13.p ? ctx.planText(bU13.p) : ''));
ok('难单元会提示拆课或补作业', (() => {
  const w = bU13.p.pacing.warn.join(' ');
  return /拆成|补 \d+ 次|多排 1 节/.test(w);
})(), bU13.p.pacing.warn.join(' | ').slice(0, 120));

// ---- 全 48 课次 × 多组合批量 ----
let combos = 0, errs = [];
for (const lesson of [1, 16, 27, 48]) for (const minutes of [60, 90]) for (const tech of [0, 3, 5]) for (const fit of [0, 3, 5]) for (const age of ['adult', 'youth', 'senior', 'mixed']) for (const goal of X.GOALS) {
  try {
    const r = gen([mk({ techScore: tech, fitScore: fit, pkLevel: tech, age: age === 'mixed' ? 'adult' : age, goal })], { lesson, minutes, age, goal });
    const tt = ctx.planText(r.p) + ctx.renderPlanHTML(r.p);
    if (/\[N\]|\{p:/.test(tt)) errs.push(`占位残留 L${lesson}/${minutes}/${tech}/${fit}/${age}/${goal}`);
    if (r.p.struct.reduce((a, b) => a + (b.end - b.start), 0) !== minutes) errs.push(`时长 L${lesson}/${minutes}/${goal}`);
    combos++;
  } catch (e) { errs.push(`EXCEPTION L${lesson}/${minutes}/${tech}/${fit}/${age}/${goal}: ${e.message}`); }
}
ok('48 课次组合批量无异常', errs.length === 0, errs.slice(0, 4).join(' | '));
console.log(`[check:frontend] combos=${combos} pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
