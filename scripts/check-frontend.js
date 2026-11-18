/* v4.1 前端生成引擎自检：模拟 DOM 执行真实 <script>，验证教案输出 */
const fs = require('fs'), vm = require('vm');
const path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'index.html'), 'utf8');
const code = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1] + '\n;globalThis.__X={UNITS,LESSONS,SEGMENTS,PARAMS,GOALS,SCORE_MATRIX,TECH_A,RACKET_B,FIT_ANCHOR,STAGES,AGE_GROUPS,ZONES,state};';
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
function gen(students, form) {
  vm.runInContext('state.students = ' + JSON.stringify(students) + ';', ctx);
  const f = Object.assign({ studentIds: students.map(s => s.id), lesson: 13, minutes: 90, age: 'adult', size: 'small', date: '2026-11-14', fitMode: 'auto', focus: 'tech', goal: '技术晋级' }, form || {});
  const p = ctx.buildPlan(f);
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
