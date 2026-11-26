'use strict';
/**
 * 身体素质测评计分引擎（纯函数，可单测）
 *
 * 设计原则：
 * 1) 统一输出 0-100 指数，便于跨项目比较与画雷达图；但指数不是官方常模，只做「本馆参考分档」。
 * 2) 三级折算，顺序固定：① 变体系数（如跪姿俯卧撑）→ ② 性别系数 → ③ 年龄组让步。
 *    性别系数只调整「绝对成绩」的分档起点，不表达能力差；同分位即同等训练分层。
 *    - 变体 / 性别：直接折算原始值（higher 类除以系数，lower 类乘以系数）。
 *    - 年龄组：在「指数空间」而非原始值空间让子 —— 离 100 分的差距按系数缩放，
 *      公式 index' = 100 − (100 − index) × e。e<1 = 该年龄段标准更宽松（同成绩得更高指数），
 *      e>1 = 更严格。这样对 higher / lower、对负值项目（坐位体前屈）都同样成立，
 *      不会出现「锚点压缩导致某个区间反而更严」的算法扭曲。
 * 3) 未测 / 中止 / 禁忌项一律返回 null，不当作 0 分（与阶段评估体系保持同一安全口径）。
 * 4) 分档为「参考分档（推定值）」；本馆实测 ≥30 人后替换为实测分位，历史报告保留旧快照。
 */

const ANCHOR_INDEX = [10, 35, 60, 80, 100]; // 5 个锚点对应的指数

const LEVEL_LABEL = ['待建立', '偏弱', '一般', '良好', '优秀'];

const DEFAULT_AGE_SENSITIVITY = {
  reaction: 0.85, agility: 0.85, power: 0.9, strength: 0.8, core: 0.78,
  endurance: 0.92, flexibility: 0.5, balance: 0.65, coordination: 0.65
};

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round = (v, d = 1) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

function findAgeGroup(spec, age) {
  const n = Number(age);
  if (!Number.isFinite(n)) return spec.ageGroups.find(g => g.code === 'a18');
  return spec.ageGroups.find(g => n >= g.minAge && n <= g.maxAge) ||
    spec.ageGroups[spec.ageGroups.length - 1];
}

const findItem = (spec, code) => spec.items.find(i => i.code === code) || null;
const findByNo = (spec, no) => spec.items.find(i => i.no === Number(no)) || null;

/** 取某项的有效量表：变体自带 altAnchorsByVariant 时优先（如立定跳远 → 坐站起立计时） */
function resolveScale(item, variantCode) {
  const alt = item.altAnchorsByVariant && variantCode ? item.altAnchorsByVariant[variantCode] : null;
  if (alt) return { anchors: alt.anchors, direction: alt.direction, unit: alt.unit, factor: 1 };
  const variant = (item.variants || []).find(v => v.code === variantCode);
  return {
    anchors: item.anchors, direction: item.direction, unit: item.unit,
    factor: variant && variant.factor != null ? Number(variant.factor) : 1
  };
}

/** 变体 + 性别折算：higher 类「除以系数」，lower 类「乘以系数」；系数 >1 = 该版本更容易 / 该群体标准更低 */
function normalizeRaw(raw, item, scale, sex) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  const sexFactor = (item.sexFactor && item.sexFactor[sex]) || 1;
  const f = scale.factor * sexFactor;
  if (!f || !Number.isFinite(f)) return n;
  return scale.direction === 'higher' ? n / f : n * f;
}

/**
 * 年龄组让步：在指数空间缩放离 100 分的差距。
 * e 取年龄组 dimensionFactor[维度]，缺省回落到 ageGroup.factor × 维度敏感度。
 * e<1 宽松（同成绩指数更高）；e>1 严格。
 */
function ageFactorFor(ageGroup, dimension) {
  if (!ageGroup) return 1;
  if (ageGroup.dimensionFactor && ageGroup.dimensionFactor[dimension] != null) {
    return clamp(Number(ageGroup.dimensionFactor[dimension]), 0.4, 1.4);
  }
  const sens = DEFAULT_AGE_SENSITIVITY[dimension] != null ? DEFAULT_AGE_SENSITIVITY[dimension] : 0.8;
  const factor = ageGroup.factor != null ? Number(ageGroup.factor) : 1;
  return clamp(1 - (1 - factor) * sens, 0.4, 1.4);
}

function ageAdjustIndex(index, ageGroup, dimension) {
  if (index == null || !Number.isFinite(index)) return null;
  const e = ageFactorFor(ageGroup, dimension);
  return clamp(100 - (100 - index) * e, 0, 100);
}

/** 0-100 指数：在 5 个锚点区间内线性插值，超出则取端点 */
function indexFromAnchors(value, anchors, direction) {
  if (value == null) return null;
  const v = direction === 'higher' ? value : -value;
  const a = anchors.map(x => (direction === 'higher' ? x : -x));
  if (v <= a[0]) return ANCHOR_INDEX[0];
  if (v >= a[4]) return ANCHOR_INDEX[4];
  for (let i = 0; i < 4; i++) {
    if (v <= a[i + 1]) {
      const span = a[i + 1] - a[i];
      const t = span === 0 ? 0 : (v - a[i]) / span;
      return ANCHOR_INDEX[i] + t * (ANCHOR_INDEX[i + 1] - ANCHOR_INDEX[i]);
    }
  }
  return ANCHOR_INDEX[4];
}

function levelFromIndex(index) {
  if (index == null) return null;
  if (index < ANCHOR_INDEX[1]) return 0;
  if (index < ANCHOR_INDEX[2]) return 1;
  if (index < ANCHOR_INDEX[3]) return 2;
  if (index < ANCHOR_INDEX[4]) return 3;
  return 4;
}

/**
 * 单测一项。
 * input: { itemCode | itemNo, rawValue, trials?, variantCode?, status?, note? }
 * ctx:   { ageGroup, sex }
 */
function scoreItem(spec, input, ctx) {
  const item = input.itemCode ? findItem(spec, String(input.itemCode)) : findByNo(spec, input.itemNo);
  if (!item) {
    const e = new Error('未知测评项目：' + (input.itemCode || input.itemNo));
    e.code = 'UNKNOWN_ITEM';
    throw e;
  }
  const status = input.status || 'measured';
  const scale = resolveScale(item, input.variantCode);
  const variant = (item.variants || []).find(v => v.code === input.variantCode) || null;
  const base = {
    itemCode: item.code, itemName: item.name, dimension: item.dimension,
    variantCode: variant ? variant.code : null, variantName: variant ? variant.name : null,
    unit: scale.unit, direction: scale.direction,
    rawValue: null, normalizedValue: null,
    trials: Array.isArray(input.trials) ? input.trials.slice(0, 20) : [],
    status, level: null, indexValue: null,
    note: input.note ? String(input.note).slice(0, 500) : ''
  };
  if (status !== 'measured') return base;

  const raw = Number(input.rawValue);
  if (!Number.isFinite(raw)) {
    const err = new Error(`「${item.name}」的实测值必须为数字`);
    err.code = 'INVALID_VALUE';
    throw err;
  }
  const normalized = normalizeRaw(raw, item, scale, ctx.sex);
  const baseIndex = indexFromAnchors(normalized, scale.anchors, scale.direction);
  const index = clamp(ageAdjustIndex(baseIndex, ctx.ageGroup, item.dimension), 0, 100);
  return Object.assign(base, {
    rawValue: raw,
    normalizedValue: round(normalized, 2),
    level: levelFromIndex(index),
    indexValue: round(index, 1)
  });
}

/**
 * 计算整份报告（不修改入参）。
 * results: scoreItem 输出数组；未列出的项目进入 missing，不当作 0 分。
 */
function computeReport(spec, { age, sex, ageGroupCode, results }) {
  const ageGroup = (ageGroupCode && spec.ageGroups.find(g => g.code === ageGroupCode)) || findAgeGroup(spec, age);
  const measured = results.filter(r => r.status === 'measured' && r.indexValue != null);
  const dims = Object.keys(spec.weights);

  const dimensions = dims.map(dim => {
    const inDim = measured.filter(r => r.dimension === dim);
    const avg = inDim.length ? inDim.reduce((s, r) => s + r.indexValue, 0) / inDim.length : null;
    const meta = (spec.dimensions && spec.dimensions[dim]) || {};
    const lv = levelFromIndex(avg);
    return {
      code: dim,
      name: meta.name || dim,
      pickleball: meta.pickleball || '',
      weight: spec.weights[dim],
      index: round(avg, 1),
      level: lv,
      levelLabel: avg == null ? '未测' : LEVEL_LABEL[lv],
      items: inDim.map(r => r.itemCode),
      measured: inDim.length
    };
  });

  // 只对「测到的维度」重新归一权重：未测不当作 0 分拉低总分
  const weighted = dimensions.filter(d => d.index != null);
  const usedWeight = weighted.reduce((s, d) => s + d.weight, 0);
  const totalIndex = usedWeight > 0 ? weighted.reduce((s, d) => s + d.index * d.weight, 0) / usedWeight : null;
  const band = totalIndex == null ? null
    : (spec.fitScoreBands.find(b => totalIndex >= b.min && totalIndex < b.max) || spec.fitScoreBands[spec.fitScoreBands.length - 1]);

  const rank = weighted.slice().sort((a, b) => b.index - a.index);
  const missing = spec.items.filter(i => !results.some(r => r.itemCode === i.code))
    .map(i => ({ itemCode: i.code, itemName: i.name, dimension: i.dimension }));
  const notMeasured = results.filter(r => r.status !== 'measured')
    .map(r => ({ itemCode: r.itemCode, itemName: r.itemName, status: r.status, note: r.note }));

  return {
    battery: { code: spec.code, version: spec.version, name: spec.name },
    ageGroup: { code: ageGroup.code, name: ageGroup.name, factor: ageGroup.factor, rpeCap: ageGroup.rpeCap },
    sex: sex || null,
    results,
    dimensions,
    totalIndex: round(totalIndex, 1),
    fitScore: band ? band.score : null,
    fitScoreLabel: band ? band.label : null,
    coverage: { measured: measured.length, total: spec.items.length },
    strongest: rank.slice(0, 2),
    weakest: rank.slice(-2).reverse(),
    missing, notMeasured,
    disclaimer: spec.calibrationNote,
    safety: spec.safetyGeneral
  };
}

/** 报告 → 训练计划适配建议（供教案生成 / 体能与计划适配面板使用） */
function planAdvice(spec, report) {
  const dimOrder = ['endurance', 'agility', 'reaction', 'strength', 'core', 'power', 'balance', 'flexibility', 'coordination'];
  const byCode = new Map(report.dimensions.map(d => [d.code, d]));
  const dimMap = spec.planMapping || {};
  const weak = dimOrder.map(c => byCode.get(c)).filter(d => d && d.index != null && d.index < 52);
  const strong = report.strongest.filter(d => d.index != null && d.index >= 70);
  const suggestions = weak.map(d => ({
    dimension: d.code, dimensionName: d.name, priority: '首要补强',
    text: dimMap[d.code] || `④ 段补 ${d.name}`
  }));
  if (!weak.length && report.totalIndex != null) {
    suggestions.push({ dimension: null, dimensionName: null, priority: '维持', text: '各维度均在「一般」以上，按常规 ④ 段执行，不额外加量。' });
  }
  for (const d of strong) {
    suggestions.push({
      dimension: d.code, dimensionName: d.name, priority: '可作为优势',
      text: `优势项 ${d.name}（指数 ${d.index}），对抗段可用于建立信心；不作为削减基础练习的理由。`
    });
  }
  return {
    suggestions,
    loadGuard: report.ageGroup.rpeCap <= 4 || report.totalIndex == null || report.totalIndex < 36,
    rpeCap: report.ageGroup.rpeCap,
    note: '体能报告只影响 ④ 体能段的重点与负荷上限，不改变 48 课次技术主线顺序。'
  };
}

/** 与教练主观 0-5 入班体能的对照（只做交叉校验提示，不自动改写档案分数） */
function compareWithCoachScore(report, coachScore) {
  if (report.fitScore == null || coachScore == null || coachScore === '') return null;
  const cs = Number(coachScore);
  if (!Number.isFinite(cs)) return null;
  const diff = report.fitScore - cs;
  return {
    coachScore: cs,
    measuredScore: report.fitScore,
    diff,
    verdict: Math.abs(diff) <= 1 ? '一致' : (diff >= 2 ? '实测高于自评，可适度加量' : '实测低于自评，建议按实测执行')
  };
}

module.exports = {
  ANCHOR_INDEX, LEVEL_LABEL, DEFAULT_AGE_SENSITIVITY,
  findAgeGroup, findItem, findByNo, resolveScale,
  normalizeRaw, ageFactorFor, ageAdjustIndex, indexFromAnchors, levelFromIndex,
  scoreItem, computeReport, planAdvice, compareWithCoachScore
};
