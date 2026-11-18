'use strict';
/**
 * P7 课程大纲引擎（纯函数，无数据库依赖，便于单测与前端共用）
 *
 * 设计口径（与 A 部分审阅结论一致）：
 *   1. 课次数量由「技术难度 × 剂量」估算，不由「一周几次」倒推。
 *      - 每节课每人高质量实球触球 ≈ 28-34 次（教练手喂 + 移动中击球）
 *      - 某技术从「能做出来」到「敢在比赛里用」需要若干倍于此的总触球数
 *      - 因此 difficult 单元的 doseMultiplier > 1，即需要更多节课去分摊
 *   2. 单节课并列新授点上限 3 个。超过一律拆课，不在一节课里塞 6-9 个技术点。
 *   3. 难点不靠「多讲一遍」解决，靠「多练几课 + 插入补强课（R）」。R 课只加频次，不加时长。
 *   4. paceMode=fixed 时不允许插入 R 课：购买课数固定时，宁可把某课标为「部分达标、留下一课补」，也不偷偷多排课。
 *   5. 任何情况下不改变单次课时长，不改 48 课次主线内容，不动考核与晋级判定。
 */

const MAX_NEW_POINTS = 3;           // 单节新授点硬上限
const MIN_REPS_PER_POINT = 25;      // 每个新授点至少需要的实球触球
const BASE_QUALITY_REPS = 32;       // 成人 / 技术 3 / 体能 3 时每节实球触球基准

/** 技术等级对剂量的影响：基础越差，同样的课时能消化的新点越少 */
function techFactor(techLevel) {
  const t = Number(techLevel);
  if (!Number.isFinite(t)) return 1;
  if (t <= 1) return 0.6;
  if (t === 2) return 0.85;
  if (t === 3) return 1;
  if (t === 4) return 1.2;
  return 1.35;
}

/** 体能 / 年龄对剂量的影响：常青与体能弱者降到 0.75，且不允许插入高强度 R 课 */
function loadFactor(fitLevel, ageGroup) {
  const f = Number(fitLevel);
  let v = Number.isFinite(f) ? (f <= 1 ? 0.7 : f === 2 ? 0.9 : f === 3 ? 1 : f === 4 ? 1.1 : 1.2) : 1;
  if (ageGroup === 'senior') v *= 0.8;
  if (ageGroup === 'youth') v *= 0.9;
  return Math.round(v * 100) / 100;
}

/** 每节课能提供的实球触球数（用于判断剂量够不够） */
function repsPerLesson(techLevel, fitLevel, ageGroup, minutes = 90) {
  const base = BASE_QUALITY_REPS * techFactor(techLevel) * loadFactor(fitLevel, ageGroup);
  const scaled = minutes === 60 ? base * 0.58 : minutes === 120 ? base * 1.25 : base;
  return Math.max(8, Math.round(scaled));
}

function indexUnits(difficultySpec) {
  const map = new Map();
  for (const u of (difficultySpec && difficultySpec.units) || []) map.set(Number(u.u), u);
  return map;
}

/**
 * 估算「学会一个单元需要几节课」。
 *
 * 口径说明（重要）：
 *   课堂只承担「首次建立动作 + 纠错 + 迁移到对抗」，约占全部触球的 35%；
 *   其余靠家庭作业与自由打球积累。因此不能拿「总需触球数 ÷ 每课触球数」直接当课次，
 *   否则会把 48 课次体系算成 200 课次，脱离实际。
 *
 * 判定顺序：
 *   1. 难度基准课次（1→1、2→2、3→2、4→2、5→3）
 *   2. 并列新授点：ceil(newPoints / 3)
 *   3. 取两者较大值；难度 5 的单元不低于 3 课
 *   4. 基础弱（每课实球触球 < 24）再加 1 课，最多 4 课
 *   5. 算出的课次仍不够覆盖「课堂应承担的 35% 触球」时，不硬加课次，而是给出作业补量建议
 */
function lessonsForUnit(unitDiff, ctx) {
  const u = unitDiff || { difficulty: 3, newPoints: 3, repsToUsable: 600 };
  const difficulty = Number(u.difficulty) || 3;
  const newPoints = Number(u.newPoints) || 3;
  const repsToUsable = Number(u.repsToUsable) || 600;
  const reps = repsPerLesson(ctx.techLevel, ctx.fitLevel, ctx.ageGroup, ctx.minutes);

  const baseByDifficulty = { 1: 1, 2: 2, 3: 2, 4: 2, 5: 3 }[difficulty] || 2;
  const byPoints = Math.ceil(newPoints / MAX_NEW_POINTS);
  let needed = Math.max(baseByDifficulty, byPoints);
  if (difficulty >= 5) needed = Math.max(needed, 3);
  if (reps < 24 && needed < 4) needed += 1;
  needed = Math.max(1, Math.min(4, needed));

  // 课堂剂量自检：课堂应承担总需求的 35%
  const shouldCarry = Math.round(repsToUsable * 0.35);
  const willCarry = reps * needed;
  const gap = Math.max(0, shouldCarry - willCarry);
  const homeworkReps = gap > 0 ? Math.round(gap / Math.max(1, needed)) : 0;

  const reasons = [];
  reasons.push(`每节实球触球 ${reps} 次 × ${needed} 课 = ${willCarry} 次`);
  reasons.push(`该技术从「能做出来」到「敢在比赛里用」约需 ${repsToUsable} 次，课堂承担约 35%（${shouldCarry} 次）`);
  if (byPoints > baseByDifficulty) reasons.push(`原教案并列新授点 ${newPoints} 个 → 至少拆 ${byPoints} 课（单课上限 ${MAX_NEW_POINTS} 个）`);
  if (homeworkReps > 0) reasons.push(`课堂缺口 ${gap} 次 → 每课需补家庭作业约 ${homeworkReps} 次（对墙 / 徒手 / 抛球）`);

  return {
    lessonsNeeded: needed, repsPerLesson: reps, repsToUsable,
    shouldCarry, willCarry, homeworkReps,
    reason: reasons.join('；')
  };
}

/** 生成大纲：把购买课数分配到单元序列上 */
function buildOutline(opts) {
  const o = opts || {};
  const totalLessons = Math.max(1, Math.min(200, Number(o.totalLessons) || 10));
  const startStage = Math.max(1, Math.min(3, Number(o.startStage) || 1));
  const startUnit = Math.max(1, Math.min(24, Number(o.startUnit) || ((startStage - 1) * 8 + 1)));
  const maxUnit = 24;
  const ctx = {
    techLevel: o.techLevel == null ? 3 : Number(o.techLevel),
    fitLevel: o.fitLevel == null ? 3 : Number(o.fitLevel),
    ageGroup: o.ageGroup || 'adult',
    minutes: Number(o.minutes) || 90
  };
  const diffs = indexUnits(o.difficulty);
  const mode = o.paceMode === 'fixed' ? 'fixed' : 'adaptive';
  const lessonsPerWeek = Math.max(1, Math.min(7, Number(o.lessonsPerWeek) || 2));
  const startDate = o.startDate || new Date().toISOString().slice(0, 10);

  const rows = [];
  const log = [];
  let unit = startUnit;

  while (rows.length < totalLessons && unit <= maxUnit) {
    const d = diffs.get(unit) || { u: unit, difficulty: 3, newPoints: 3, repsToUsable: 600 };
    const plan = lessonsForUnit(d, ctx);
    const remaining = totalLessons - rows.length;
    const cap = mode === 'fixed' ? 2 : 4;
    const allot = Math.max(1, Math.min(mode === 'fixed' ? Math.min(plan.lessonsNeeded, 2) : plan.lessonsNeeded, remaining));
    const lessonsNeededShown = mode === 'fixed' ? Math.min(plan.lessonsNeeded, cap) : plan.lessonsNeeded;
    log.push({
      unit,
      tech: d.tech || '',
      difficulty: d.difficulty,
      newPoints: d.newPoints,
      lessonsNeeded: lessonsNeededShown,
      allotted: allot,
      repsPerLesson: plan.repsPerLesson,
      repsToUsable: plan.repsToUsable,
      reason: plan.reason,
      truncated: plan.lessonsNeeded > allot
    });
    for (let i = 0; i < allot; i += 1) {
      // 第 1 节 A 新授；第 2 节 B 巩固；第 3 节起 R 补强（同单元、只练未达标判据）
      const lessonType = i === 0 ? 'A' : (i === 1 ? 'B' : 'R');
      const offsetInPackage = rows.length; // 0-based
      rows.push({
        seq: offsetInPackage + 1,
        unit_no: unit,
        lesson_no: (unit - 1) * 2 + (lessonType === 'A' ? 1 : 2),
        lesson_type: lessonType,
        planned_date: addDays(startDate, slotOffset(offsetInPackage, lessonsPerWeek)),
        minutes: ctx.minutes,
        difficulty: d.difficulty,
        newPoints: d.newPoints,
        pace: {
          difficulty: d.difficulty,
          newPoints: d.newPoints,
          lessonsForUnit: plan.lessonsNeeded,
          repsPerLesson: plan.repsPerLesson,
          repsToUsable: plan.repsToUsable,
          prereq: d.prereq || [],
          gate: d.gate || '',
          splitAdvice: d.splitAdvice || ''
        }
      });
    }
    unit += 1;
  }

  // 覆盖不足：课时用完但还没走到第 24 单元（含 48 课全程也没覆盖完的情况）
  const truncated = rows.length >= totalLessons && unit <= maxUnit;
  return {
    model: 'P7-outline-v1',
    ctx,
    paceMode: mode,
    lessonsPerWeek,
    rows,
    byUnit: log,
    covered: rows.reduce((a, r) => a + r.minutes, 0),
    truncated,
    truncatedReason: truncated
      ? `购买 ${totalLessons} 节课不足以覆盖到第 24 单元；已排到第 ${unit > maxUnit ? maxUnit : unit - 1} 单元，剩余课时请在新课程包里续排。`
      : '',
    note: mode === 'fixed'
      ? '固定节奏：严格按购买课数排满，未达标时不插入额外补强课，只在下一课的「补强」栏位重练。'
      : '自适应节奏：难点单元自动多排 1-2 节同单元补强课（R 型），总课时不变、单次时长不变。'
  };
}

/** 某节课未达标时，给出下一节课怎么调（不新增购买课数，只调整顺序或插入 R 课） */
function nextLessonAdvice(outline, seq, judge) {
  const rows = (outline && outline.rows) || [];
  const cur = rows.find(r => r.seq === Number(seq));
  if (!cur) return null;
  // 兼容两种字段命名：引擎内部 unit_no / 服务层 mapOutline 后的 unitNo
  const unitNo = cur.unit_no != null ? cur.unit_no : cur.unitNo;
  const lessonNo = cur.lesson_no != null ? cur.lesson_no : cur.lessonNo;
  const passed = judge === '达标';
  const partial = judge === '部分达标';
  const next = rows.find(r => r.seq === Number(seq) + 1);
  if (passed) {
    return {
      action: 'keep',
      text: next
        ? `按大纲进入第 ${next.seq} 节（第 ${next.lesson_no != null ? next.lesson_no : next.lessonNo} 课 · 第 ${next.unit_no != null ? next.unit_no : next.unitNo} 单元）。`
        : '本课程包已排满；建议开设续包并把本单元最后一课作为复查课。'
    };
  }
  if (outline && outline.paceMode === 'fixed') {
    return {
      action: 'hold',
      text: `固定节奏：不插入额外补强课。下一节（第 ${next ? next.seq : '-'} 节）沿用本单元动作，把今天未达标的判据放在 ③ 分解练习前 5 分钟复习，不延长课时。`
    };
  }
  return {
    action: partial ? 'insert_r' : 'repeat',
    text: partial
      ? `自适应节奏：建议在第 ${Number(seq) + 1} 节插入 1 节「第 ${unitNo} 单元补强（R）」，只练今天未达标的判据，其余课时顺延。`
      : `未达标不进入下一单元：第 ${Number(seq) + 1} 节重复第 ${unitNo} 单元同类课，并把难度下调一档（缩短距离 / 降低球速 / 去掉移动中击球）。`
  };
}

function addDays(dateStr, days) {
  const d = new Date(String(dateStr) + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return dateStr;
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

/** 每周 N 节：把第 i 节均匀摊到周一至周日（周 2 节 → 周一、周四） */
function slotOffset(i, perWeek) {
  const week = Math.floor(i / perWeek);
  const inWeek = i % perWeek;
  const step = perWeek <= 1 ? 0 : 7 / perWeek;
  return week * 7 + Math.round(inWeek * step);
}

module.exports = {
  MAX_NEW_POINTS, MIN_REPS_PER_POINT, BASE_QUALITY_REPS,
  techFactor, loadFactor, repsPerLesson, lessonsForUnit, buildOutline,
  nextLessonAdvice, addDays, slotOffset
};
