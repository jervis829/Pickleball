#!/usr/bin/env node
'use strict';
/* V3.0 配置驱动课程体系与零道具体能自检 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const curCfg = JSON.parse(fs.readFileSync(path.join(root, 'database/seeds/curriculum-config.json'), 'utf8'));
const fitBat = JSON.parse(fs.readFileSync(path.join(root, 'database/seeds/fitness-court-6.json'), 'utf8'));
const v22Doc = fs.readFileSync(path.join(root, 'docs/匹克球教学技术大纲_V2.2.md'), 'utf8');

const defCtx = { globalThis: {} };
defCtx.window = defCtx;
vm.runInNewContext(fs.readFileSync(path.join(root, 'frontend/v3-defaults.js'), 'utf8'), defCtx);

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) pass++;
  else { fail++; console.error('  FAIL:', name, extra === undefined ? '' : extra); }
};

/* 1. 课程配置结构校验 */
ok('V3 大纲默认课时为 60 分钟', curCfg.defaultMinutes === 60, curCfg.defaultMinutes);
ok('评分刻度为 0..5（0=不会，无未评估）', Array.isArray(curCfg.scoringScale) && curCfg.scoringScale.length === 6 && curCfg.scoringScale[0].score === 0 && curCfg.scoringScale[0].label === '不会' && !JSON.stringify(curCfg.scoringScale).includes('未评估'));
ok('赛道含 basic + advanced', curCfg.tracks.length === 2 && curCfg.tracks[0].id === 'basic' && curCfg.tracks[1].id === 'advanced');
ok('7 大技术类别齐全且为 6+4 混合制', curCfg.categories.length === 7 && curCfg.categories.every(c => c.trackWeights.basic === 6 && c.trackWeights.advanced === 4));
ok('总计 34 个技术模块（B01-B12 + A01-A22）', curCfg.modules.length === 34, curCfg.modules.length);

const codes = new Set(curCfg.modules.map(m => m.code));
ok('无独立 B00 课', !codes.has('B00'));
ok('已删除 A23 双打攻防协同', !codes.has('A23'));
ok('B01 含前10分钟核心微讲', /10分钟|握拍/.test(curCfg.modules.find(m => m.code === 'B01').title + JSON.stringify(curCfg.modules.find(m => m.code === 'B01').plan60)));
ok('A05-A08 含 Drip 与第五拍 Drop 衔接', /Drip|第五拍/.test(curCfg.modules.filter(m => /^A0[5-8]$/.test(m.code)).map(m => m.title + m.kp.join(',')).join(' ')));
ok('所有模块 seq 1..34 连续且都有 60 分钟教案模板', curCfg.modules.every((m, i) => m.seq === i + 1 && m.plan60 && Array.isArray(m.plan60.drills) && m.plan60.drills.length >= 1));
ok('所有预设组包引用有效模块代码', curCfg.bundles.every(b => b.codes.every(c => codes.has(c))));

/* 2. 6 维零道具球场体能校验 */
const expectedDims = ['爆发力', '反应', '移动', '平衡', '柔韧', '耐力'];
ok('6 维球场体能维度名按方案A（含「移动」）', JSON.stringify(fitBat.dimensions.map(d => d.name)) === JSON.stringify(expectedDims));
const fitText = JSON.stringify(fitBat.equipment) + JSON.stringify(fitBat.dimensions.map(d => d.method));
ok('6 维体能零道具且无心率/无目测字段', !/bpm|瑜伽垫|弹力带|直尺|卷尺|俯卧撑|平板支撑/.test(fitText) && fitText.includes('不测心率'));
ok('男女 × 6 年龄段常模锚点全齐且严格单调', fitBat.dimensions.every(d => ['male', 'female'].every(g => ['u12', 'u17', 'a18', 'a35', 'a50', 'a65'].every(ag => {
  const arr = fitBat.anchors[d.key][g][ag];
  if (!Array.isArray(arr) || arr.length !== 5) return false;
  return d.direction === 'lower_better'
    ? arr.every((v, i) => i === 0 || v < arr[i - 1])
    : arr.every((v, i) => i === 0 || v > arr[i - 1]);
}))));

/* 3. 前端兜底配置与后端种子完全一致 */
ok('v3-defaults.js 课程配置与 curriculum-config.json 一致', JSON.stringify(defCtx.PKB_DEFAULT_CURRICULUM) === JSON.stringify(curCfg));
ok('v3-defaults.js 体能配置与 fitness-court-6.json 一致', JSON.stringify(defCtx.PKB_DEFAULT_FITNESS) === JSON.stringify(fitBat));
ok('V2.2 教学大纲文档存在', v22Doc.includes('V2.2') && v22Doc.includes('B01'));

console.log(`[check:curriculum] pass=${pass} fail=${fail} · V3.0 配置(${curCfg.modules.length}模块) & 6维球场体能校验通过`);
process.exit(fail ? 1 : 0);
