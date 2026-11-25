#!/usr/bin/env node
'use strict';
/* V3.0 前端核心页面渲染流自检（今日工作台 / 学员报告与快照对比 / 灵活计划与60分钟教案 / 大纲配置中心） */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
const defaultsCode = fs.readFileSync(path.join(root, 'frontend/v3-defaults.js'), 'utf8');
const inlineCode = (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1];

const nodes = new Map();
function mkEl(sel) {
  return {
    _sel: sel, innerHTML: '', textContent: '', value: '', hidden: false, style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, getAttribute() { return null; }, appendChild() {}, remove() {},
    addEventListener() {}, querySelectorAll() { return []; }, querySelector() { return mkEl(sel + '>'); },
    focus() {}, click() {}
  };
}
const q = (sel) => { if (!nodes.has(sel)) nodes.set(sel, mkEl(sel)); return nodes.get(sel); };
const cache = {};
const ctx = {
  console,
  document: {
    body: mkEl('body'), documentElement: mkEl('html'),
    querySelector: q, querySelectorAll() { return []; },
    addEventListener() {}, createElement() { return mkEl('created'); }, dispatchEvent() {}
  },
  localStorage: { getItem: k => (k in cache ? cache[k] : null), setItem: (k, v) => { cache[k] = String(v); }, removeItem: k => { delete cache[k]; } },
  navigator: {}, setTimeout: () => 1, clearTimeout() {},
  Date, Math, JSON, Number, String, Array, Object, Set, Map, isFinite, parseInt, parseFloat,
  Promise, RegExp, Error, CustomEvent: class {}, confirm: () => false
};
ctx.window = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(defaultsCode, ctx);
vm.runInContext(inlineCode, ctx);

const FE = ctx.__V3;
const V3 = FE.V3;

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.error('  FAIL:', name, extra || ''); } };

/* 注入模拟 V3 状态并触发全视图渲染 */
const v3Cur = require('../backend/src/services/v3-curriculum');
const v3Fit = require('../backend/src/services/v3-fitness');
const cfg = v3Cur.readSeedConfig();
const catBase = v3Cur.computeCategoryScores({}, cfg);
const catAfter = v3Cur.computeCategoryScores({ B01: 4, B04: 3 }, cfg);
const fitRpt = v3Fit.evaluateBattery({
  power: { skipped: true, skipReason: '护膝' },
  reaction: { value: 4 }, mobility: { value: 6 }, balance: { value: 30 },
  flexibility: { bendLevel: 4, shoulderLevel: 3 }, endurance: { value: 16 }
}, { gender: 'female', ageGroup: 'a18' });

V3.students = [{ id: 'S1', name: '林小满', gender: 'female', fitnessAgeGroup: 'a18', target: '3.0', overallScore: catAfter.overallScore, masteredCount: 2, totalModules: 34, latestFitnessIndex: fitRpt.totalIndex }];
V3.activeStudentId = 'S1';
V3.activeStudentReport = {
  student: V3.students[0],
  latestSnapshot: { id: 'SNP2', triggerType: 'lesson_review', curriculumVersion: '2.2.0', overallScore: catAfter.overallScore, categories: catAfter.categories, createdAt: '2026-11-18T10:00:00Z', summaryNote: '第1节B01课后' },
  liveAssessment: { curriculumVersion: '2.2.0', overallScore: catAfter.overallScore, categories: catAfter.categories, modules: cfg.modules.map(m => ({ ...m, score: m.code === 'B01' ? 4 : (m.code === 'B04' ? 3 : 0), practiceCount: m.code === 'B01' ? 1 : 0 })) },
  snapshots: [
    { id: 'SNP2', triggerType: 'lesson_review', curriculumVersion: '2.2.0', overallScore: catAfter.overallScore, categories: catAfter.categories, createdAt: '2026-11-18T10:00:00Z', summaryNote: '第1节B01课后' },
    { id: 'SNP1', triggerType: 'baseline', curriculumVersion: '2.2.0', overallScore: catBase.overallScore, categories: catBase.categories, createdAt: '2026-11-10T09:00:00Z', summaryNote: '建档基线' }
  ],
  fitnessHistory: [fitRpt],
  latestFitness: fitRpt
};

V3.plans = [{
  id: 'P1', name: '林小满 1v1 60分计划', packageType: 'solo', totalLessons: 2, usedLessons: 1, defaultMinutes: 60, status: 'active',
  students: [{ id: 'S1', name: '林小满' }],
  lessons: [
    { id: 'L1', seq: 1, moduleCode: 'B01', moduleTitle: '基础发球', plannedDate: '2026-11-18', minutes: 60, status: 'completed', locked: true, reviews: [{ studentId: 'S1', attend: 'present', moduleScores: { B01: 4 }, rpe: 6, feedback: '不错' }] },
    { id: 'L2', seq: 2, moduleCode: 'B02', moduleTitle: '正手底线击球', plannedDate: '2026-11-25', minutes: 60, status: 'planned', locked: false, reviews: [] }
  ]
}];
V3.activePlanId = 'P1';
V3.activeLessonId = 'L2';
V3.activeLessonDetail = {
  lesson: { id: 'L2', planId: 'P1', seq: 2, moduleCode: 'B02', plannedDate: '2026-11-25', minutes: 60, status: 'planned', locked: false },
  students: [{ id: 'S1', name: '林小满', currentModuleScore: 0 }],
  planContent: {
    moduleCode: 'B02', moduleTitle: '正手底线击球', totalMinutes: 60, goal: '建立正手击球基础', rpeTarget: 7,
    segments: [{ title: '动态热身', minutes: 8, content: '肩髋热身', fitnessLink: ['林小满(移动)：2球一组横移到位'] }],
    safetyAlerts: []
  }
};

ctx.switchView('today');
ok('今日工作台渲染包含待上课次', /林小满 1v1 60分计划/.test(q('#view-today').innerHTML));

V3.studentTab = 'report';
ctx.switchView('students');
const stuHtml = q('#view-students').innerHTML;
ok('学员报告默认展示最新快照与成长对比下拉', /当前展示/.test(stuHtml) && /对比基准/.test(stuHtml) && /7 大技术类别/.test(stuHtml));
ok('全模块打分表不含未评估文案，仅 0不会..5灵活运用', !/未评估/.test(stuHtml) && /0=不会/.test(stuHtml));

V3.studentTab = 'fitness';
ctx.switchView('students');
const fitHtml = q('#view-students').innerHTML;
ok('体能 Tab 渲染六边形雷达图与 6 维度', /6 维体能六边形雷达图/.test(fitHtml) && /爆发力/.test(fitHtml) && /移动/.test(fitHtml));

ctx.switchView('plans');
const planHtml = q('#view-plans').innerHTML;
ok('教学计划渲染已锁与待上课次', /已上完锁定/.test(planHtml) && /改模块\/合练/.test(planHtml));
ok('60 分钟教案与课后独立打分渲染正常', /体能短板课堂联动/.test(planHtml) && /确认完成上课：各自更新评分/.test(planHtml));

ctx.switchView('curriculum');
ok('大纲配置中心渲染 34 模块', /配置驱动课程体系/.test(q('#view-curriculum').innerHTML) && /B01/.test(q('#view-curriculum').innerHTML) && /A22/.test(q('#view-curriculum').innerHTML));

console.log(`[check:flow] pass=${pass} fail=${fail}`);
process.exit(fail ? 1 : 0);
