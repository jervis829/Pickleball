#!/usr/bin/env node
'use strict';
/* 技术覆盖率自检：防止再次出现 flick / roll 这类「手法层」遗漏 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const seed = JSON.parse(fs.readFileSync(path.join(root, 'database/seeds/curriculum.json'), 'utf8'));
const html = fs.readFileSync(path.join(root, 'frontend/index.html'), 'utf8');
const doc = fs.readFileSync(path.join(root, 'docs/匹克球训练体系_初学者到高阶.md'), 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.error('  FAIL:', name, extra || ''); } };

const FAMILIES = ['serve_return', 'baseline_transition', 'transition_defense', 'nvz_dink',
  'speedup_hands', 'lob_overhead', 'doubles_tactics', 'footwork_rules'];
const REQUIRED = ['backhand_flick', 'forehand_flick', 'roll_volley', 'roll_dink', 'slice_dink', 'drip', 'reset', 'block_reset',
  'fifth_drop', 'atp', 'erne', 'poach', 'stacking', 'shake_bake', 'middle_ball', 'hands_battle',
  'counter_attack', 'bounce_it', 'return_crash', 'deception', 'split_step', 'crossover',
  'stop_set_hit', 'paddle_up', 'two_bounce_rule', 'backhand_overhead', 'two_handed_speedup',
  'offensive_lob', 'defensive_lob', 'attackable_dink', 'soft_hands'];

ok('24 教学单元', seed.length === 24, seed.length);
ok('课次编号 1..24 连续', seed.every((u, i) => u.u === i + 1));
ok('三阶 8/8/8', [1, 2, 3].every(s => seed.filter(u => u.s === s).length === 8));
ok('每单元都有 tags', seed.every(u => Array.isArray(u.tags) && u.tags.length >= 2));

const allTags = new Set(seed.flatMap(u => u.tags));
for (const f of FAMILIES) {
  const units = seed.filter(u => u.tags.includes(f));
  const hands = new Set(units.flatMap(u => u.tags.filter(t => !FAMILIES.includes(t))));
  ok(`族 ${f} 已覆盖且手法 ≥2`, units.length >= 1 && hands.size >= 2, `units=${units.length} hands=${hands.size}`);
}
for (const t of REQUIRED) ok(`技术点 ${t} 未遗漏`, allTags.has(t));

/* 前端 UNITS 与种子一致 */
const m = html.match(/const UNITS=(\[[\s\S]*?\]);\n/);
ok('前端 UNITS 可解析', !!m);
if (m) {
  let fe; try { fe = JSON.parse(m[1]); } catch (e) { fe = null; }
  ok('前端 UNITS = 24', fe && fe.length === 24);
  if (fe) ok('前端与种子技术主题逐条一致', fe.every((u, i) => u.tech === seed[i].tech && u.a === seed[i].a && u.b === seed[i].b));
}

/* 体系文档与前端术语一致 */
ok('文档标题为 v4.1', /课次版 v4\.1/.test(doc));
for (const t of ['flick', 'roll volley', 'roll dink', '双维综合评定', '高阶加练', '训练参数']) {
  ok(`文档含 ${t}`, doc.includes(t));
}

/* 无方括号占位残留 */
const BAD = /\[(?:N|RPE|距离|发球机档位|成功率|重量|阻力色阶|预警课次|预警天数|回收率|低分线|触发分|晋级线-[中高]|T-[初中高])\]/g;
const seedBad = (JSON.stringify(seed).match(BAD) || []);
const htmlBad = (html.match(BAD) || []);
const docBad = (doc.match(BAD) || []);
ok('课程种子无方括号占位', seedBad.length === 0, seedBad.slice(0, 3).join(','));
ok('前端无方括号占位', htmlBad.length === 0, htmlBad.slice(0, 3).join(','));
ok('体系文档无方括号占位', docBad.length === 0, docBad.slice(0, 3).join(','));
const pKeys = new Set([...html.matchAll(/\{p:([A-Za-z0-9_]+)\}/g)].map(x => x[1]));
const pDefs = new Set([...html.matchAll(/^\s*([A-Za-z0-9_]+):\{v:/gm)].map(x => x[1]));
ok('所有训练参数都有默认值', [...pKeys].every(k => pDefs.has(k)), [...pKeys].filter(k => !pDefs.has(k)).join(','));

console.log(`[check:curriculum] pass=${pass} fail=${fail} · 8 族 / ${allTags.size} 个技术标签 / ${pKeys.size} 个训练参数`);
process.exit(fail ? 1 : 0);
