#!/usr/bin/env node
'use strict';
/* V3.0 前端计算引擎自检：校验前端算分、体能换算与六边形 SVG 与后端 100% 一致 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
const defaultsCode = fs.readFileSync(path.join(root, 'frontend/v3-defaults.js'), 'utf8');
const inlineCode = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1];
if (!inlineCode) { console.error('NO INLINE SCRIPT'); process.exit(1); }

function el() {
  return {
    innerHTML: '', textContent: '', value: '', hidden: false, style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, getAttribute() { return null; }, appendChild() {}, remove() {},
    addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return el(); },
    focus() {}, click() {}
  };
}
const cache = {};
const ctx = {
  console,
  document: {
    body: el(), documentElement: el(),
    querySelector() { return el(); }, querySelectorAll() { return []; },
    addEventListener() {}, createElement() { return el(); }, dispatchEvent() {}
  },
  localStorage: { getItem: k => (k in cache ? cache[k] : null), setItem: (k, v) => { cache[k] = String(v); }, removeItem: k => { delete cache[k]; } },
  navigator: {}, setTimeout: () => 1, clearTimeout() {},
  Date, Math, JSON, Number, String, Array, Object, Set, Map, isFinite, parseInt, parseFloat,
  Promise, RegExp, Error, CustomEvent: class {}, confirm: () => false
};
ctx.window = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(defaultsCode, ctx, { filename: 'v3-defaults.js' });
vm.runInContext(inlineCode, ctx, { filename: 'index.inline.js' });

const FE = ctx.__V3;
const v3Cur = require('../backend/src/services/v3-curriculum');
const v3Fit = require('../backend/src/services/v3-fitness');
const cfg = v3Cur.readSeedConfig();
const bat = v3Fit.getBattery();

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.error('  FAIL:', name, extra === undefined ? '' : extra); }
};

/* 1. 7大技术类别 0-10 算分前后端完全一致 */
const scoreCases = [
  {},
  { B01: 5, B04: 5, A01: 5, A02: 5 },
  { B01: 2, B02: 3, B05: 4, A05: 3, A09: 2, A15: 4, A21: 5 },
  Object.fromEntries(cfg.modules.map((m, i) => [m.code, (i % 6)]))
];
let catParityOk = true;
for (const sc of scoreCases) {
  const feRes = FE.computeCategoryScoresClient(sc, cfg);
  const beRes = v3Cur.computeCategoryScores(sc, cfg);
  if (feRes.overallScore !== beRes.overallScore) catParityOk = false;
  for (let i = 0; i < beRes.categories.length; i++) {
    if (feRes.categories[i].score !== beRes.categories[i].score) catParityOk = false;
  }
}
ok('前端 7 大类 0-10 算分与后端 100% 一致', catParityOk);

/* 2. 6维体能性别×年龄段前后端逐项一致 */
let fitParityOk = true, checkedCombos = 0;
for (const g of ['male', 'female']) {
  for (const ag of ['u12', 'u17', 'a18', 'a35', 'a50', 'a65']) {
    const sample = {
      power: { value: 16.5 },
      reaction: { value: 4 },
      mobility: { value: 9 },
      balance: { value: 25 },
      flexibility: { bendLevel: 3, shoulderLevel: 2 },
      endurance: { value: 16 }
    };
    const feF = FE.evaluateFitnessClient(sample, g, ag);
    const beF = v3Fit.evaluateBattery(sample, { gender: g, ageGroup: ag });
    checkedCombos++;
    if (feF.totalIndex !== beF.totalIndex) fitParityOk = false;
    for (let i = 0; i < beF.dimensions.length; i++) {
      if (feF.dimensions[i].score !== beF.dimensions[i].score) fitParityOk = false;
    }
  }
}
ok(`前端 6 维体能换算与后端一致（覆盖 ${checkedCombos} 种性别×年龄段）`, fitParityOk);

/* 3. 跳过项不计 0 分 + 六边形 SVG 输出完整 */
const skipSample = {
  power: { skipped: true, skipReason: '膝部旧伤' },
  reaction: { value: 4 }, mobility: { value: 8 }, balance: { value: 30 },
  flexibility: { bendLevel: 4, shoulderLevel: 3 }, endurance: { value: 17 }
};
const beSkip = v3Fit.evaluateBattery(skipSample, { gender: 'female', ageGroup: 'a50' });
const svg = FE.renderFitnessHexagonSVG(beSkip, null);
ok('跳过单项在评估结果中为 null（不计 0 分）', beSkip.dimensions[0].score === null && beSkip.dimensions[0].skipped === true);
ok('六边形 SVG 正确包含全部 6 个中文维度名', ['爆发力', '反应', '移动', '平衡', '柔韧', '耐力'].every(k => svg.includes(k)) && svg.includes('<svg'));

console.log(`[check:frontend] pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
