'use strict';
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const { get, all, run } = require('../db/connection');
const { meta } = require('../repositories/misc');
const { HttpError } = require('../utils/response');
const { newId } = require('../utils/crypto');

const TS = () => new Date().toISOString();
const BATTERY_FILE = path.join(config.ROOT, 'database', 'seeds', 'fitness-court-6.json');

let batteryCache = null;
function getBattery() {
  if (batteryCache) return JSON.parse(JSON.stringify(batteryCache));
  if (!fs.existsSync(BATTERY_FILE)) {
    throw new HttpError(500, 'FITNESS_BATTERY_MISSING', '缺少体能配置 database/seeds/fitness-court-6.json');
  }
  batteryCache = JSON.parse(fs.readFileSync(BATTERY_FILE, 'utf8'));
  return JSON.parse(JSON.stringify(batteryCache));
}

function normalizeAgeGroup(ageGroup, legacyAge) {
  const valid = new Set(['u12', 'u17', 'a18', 'a35', 'a50', 'a65']);
  if (valid.has(ageGroup)) return ageGroup;
  if (legacyAge === 'youth') return 'u17';
  if (legacyAge === 'senior') return 'a50';
  return 'a18';
}

function normalizeGender(gender) {
  return gender === 'female' ? 'female' : 'male';
}

function interpolateAnchor(val, anchors, direction) {
  // anchors = [p10, p35, p60, p80, p100] -> target scores [15, 38, 62, 82, 98]
  const ys = [15, 38, 62, 82, 98];
  const v = Number(val);
  if (!Number.isFinite(v)) return null;
  if (direction === 'lower_better') {
    // anchors 递减（如秒数越短越好：[22, 18, 15, 13, 11]）
    if (v >= anchors[0]) {
      const extra = Math.min(10, ((v - anchors[0]) / Math.max(1, anchors[0] * 0.35)) * 10);
      return Math.max(5, Math.round(ys[0] - extra));
    }
    if (v <= anchors[4]) return 100;
    for (let i = 0; i < 4; i++) {
      const a = anchors[i], b = anchors[i + 1];
      if (v <= a && v >= b) {
        const t = (a - v) / Math.max(0.0001, a - b);
        return Math.round(ys[i] + t * (ys[i + 1] - ys[i]));
      }
    }
    return ys[2];
  } else {
    // anchors 递增（越高越好）
    if (v <= anchors[0]) {
      const drop = Math.min(10, ((anchors[0] - v) / Math.max(1, anchors[0])) * 10);
      return Math.max(5, Math.round(ys[0] - drop));
    }
    if (v >= anchors[4]) return 100;
    for (let i = 0; i < 4; i++) {
      const a = anchors[i], b = anchors[i + 1];
      if (v >= a && v <= b) {
        const t = (v - a) / Math.max(0.0001, b - a);
        return Math.round(ys[i] + t * (ys[i + 1] - ys[i]));
      }
    }
    return ys[2];
  }
}

function evaluateBattery(rawInput, { gender, ageGroup, legacyAge } = {}) {
  const bat = getBattery();
  const g = normalizeGender(gender);
  const ag = normalizeAgeGroup(ageGroup, legacyAge);
  const agMeta = (bat.ageGroups || []).find(x => x.id === ag) || { id: ag, name: ag, rpeCap: 7, conservative: false };
  const input = rawInput && typeof rawInput === 'object' ? rawInput : {};

  const dimensions = [];
  const rawStored = {};
  const weakDims = [];
  const trainingHints = [];
  const safetyNotes = [];

  if (agMeta.conservative) {
    safetyNotes.push(`${agMeta.name}温和模式：建议课中 RPE 不超过 ${agMeta.rpeCap}/10，去除急刹与大幅跳跃，保证组间呼吸恢复。`);
  }

  for (const dim of bat.dimensions || []) {
    const item = input[dim.key] && typeof input[dim.key] === 'object' ? input[dim.key] : { value: input[dim.key] };
    const skipped = Boolean(item.skipped);
    const altUsed = Boolean(item.altUsed);
    const skipReason = item.skipReason ? String(item.skipReason).trim() : '';

    if (skipped) {
      rawStored[dim.key] = { skipped: true, skipReason: skipReason || '安全/旧伤跳过' };
      dimensions.push({
        key: dim.key,
        name: dim.name,
        shortLabel: dim.shortLabel || dim.name,
        unit: dim.unit,
        rawValue: null,
        effectiveValue: null,
        score: null,
        score10: null,
        skipped: true,
        altUsed: false,
        skipReason: skipReason || '安全/旧伤跳过',
        levelText: '安全跳过'
      });
      safetyNotes.push(`【${dim.name}】因「${skipReason || '安全保护'}」跳过不计 0 分；60 分钟课堂优先规避高压负荷。`);
      continue;
    }

    let rawValue = null;
    let effectiveValue = null;
    if (dim.key === 'flexibility') {
      const bRaw = item.bendLevel != null && item.bendLevel !== '' ? Number(item.bendLevel) : null;
      const sRaw = item.shoulderLevel != null && item.shoulderLevel !== '' ? Number(item.shoulderLevel) : null;
      if ((bRaw != null && (!Number.isFinite(bRaw) || bRaw < 1 || bRaw > 5)) ||
          (sRaw != null && (!Number.isFinite(sRaw) || sRaw < 1 || sRaw > 4))) {
        throw new HttpError(422, 'INVALID_FITNESS_VALUE', `${dim.name}刻度超出合法范围`);
      }
      const b = bRaw != null ? Math.max(1, Math.min(5, bRaw)) : null;
      const s = sRaw != null ? Math.max(1, Math.min(4, sRaw)) : null;
      if (b == null && s == null && item.value != null && item.value !== '') {
        const vNum = Number(item.value);
        if (!Number.isFinite(vNum) || vNum < 1 || vNum > 5) {
          throw new HttpError(422, 'INVALID_FITNESS_VALUE', `${dim.name}综合刻度需在 1–5 之间`);
        }
        rawValue = vNum;
        effectiveValue = rawValue;
      } else if (b != null || s != null) {
        const sNorm = s != null ? 1 + ((s - 1) * (4 / 3)) : null;
        if (b != null && sNorm != null) effectiveValue = Math.round(((b + sNorm) / 2) * 100) / 100;
        else if (b != null) effectiveValue = b;
        else effectiveValue = Math.round(sNorm * 100) / 100;
        rawValue = effectiveValue;
      }
      rawStored[dim.key] = { bendLevel: b, shoulderLevel: s, value: effectiveValue, skipped: false, altUsed };
    } else {
      const hasVal = item.value != null && item.value !== '';
      const num = hasVal ? Number(item.value) : null;
      if (hasVal) {
        const maxBound = dim.key === 'reaction' ? 6 : Math.max(150, (Number(dim.max) || 60) * 3);
        if (!Number.isFinite(num) || num < 0 || num > maxBound) {
          throw new HttpError(422, 'INVALID_FITNESS_VALUE', `${dim.name}实测数值无效，应在 0–${maxBound} 之间`);
        }
      }
      const autoScale = item.autoScaleAlt !== undefined ? Boolean(item.autoScaleAlt) : Boolean(altUsed);
      if (num != null && Number.isFinite(num)) {
        rawValue = num;
        effectiveValue = altUsed && autoScale && dim.altScale ? Math.round(num * dim.altScale * 100) / 100 : num;
      }
      rawStored[dim.key] = { value: rawValue, effectiveValue, skipped: false, altUsed, autoScaleAlt: autoScale };
    }

    const anchors = (((bat.anchors || {})[dim.key] || {})[g] || {})[ag];
    const score = effectiveValue != null && anchors ? interpolateAnchor(effectiveValue, anchors, dim.direction) : null;
    const score10 = score != null ? Math.round((score / 10) * 10) / 10 : null;
    let levelText = '未填';
    if (score != null) {
      if (score >= 80) levelText = '优势';
      else if (score >= 60) levelText = '良好';
      else if (score >= 45) levelText = '待强化';
      else levelText = '重点补强';
    }

    dimensions.push({
      key: dim.key,
      name: dim.name,
      shortLabel: dim.shortLabel || dim.name,
      unit: dim.unit,
      rawValue,
      effectiveValue,
      score,
      score10,
      skipped: false,
      altUsed,
      skipReason: '',
      levelText,
      referenceMedian: anchors ? anchors[2] : null
    });

    if (score != null && score < 55) {
      weakDims.push({ key: dim.key, name: dim.name, score });
      trainingHints.push({
        dimKey: dim.key,
        dimName: dim.name,
        score,
        classroomHint: dim.classroomHint,
        homeTip: dim.homeTip
      });
    }
  }

  weakDims.sort((a, b) => a.score - b.score);
  const scored = dimensions.filter(d => d.score != null && !d.skipped);
  if (!scored.length) {
    throw new HttpError(422, 'FITNESS_EMPTY_MEASURES', '至少填写一项有效体能实测数值（不可全部留空或全部跳过）');
  }
  const totalIndex = Math.round(scored.reduce((a, d) => a + d.score, 0) / scored.length);
  safetyNotes.push(bat.disclaimer);

  return {
    batteryCode: bat.code,
    batteryName: bat.name,
    gender: g,
    genderName: g === 'female' ? '女' : '男',
    ageGroup: ag,
    ageGroupName: agMeta.name,
    rpeCap: agMeta.rpeCap,
    totalIndex,
    totalIndex10: Math.round((totalIndex / 10) * 10) / 10,
    dimensions,
    weakDims,
    trainingHints,
    safetyNotes,
    rawStored
  };
}

function formatFitnessRow(row) {
  if (!row) return null;
  const bat = getBattery();
  const agMeta = (bat.ageGroups || []).find(x => x.id === row.age_group);
  return {
    id: row.id,
    studentId: row.student_id,
    testDate: row.test_date,
    gender: row.gender,
    genderName: row.gender === 'female' ? '女' : '男',
    ageGroup: row.age_group,
    ageGroupName: agMeta ? agMeta.name : row.age_group,
    rpeCap: agMeta ? agMeta.rpeCap : 7,
    raw: JSON.parse(row.raw_json || '{}'),
    dimensions: JSON.parse(row.dimensions_json || '[]'),
    totalIndex: row.total_index,
    totalIndex10: row.total_index != null ? Math.round((row.total_index / 10) * 10) / 10 : null,
    weakDims: JSON.parse(row.weak_dims_json || '[]'),
    trainingHints: JSON.parse(row.training_hints_json || '[]'),
    safetyNotes: JSON.parse(row.safety_notes_json || '[]'),
    note: row.note || '',
    createdAt: row.created_at
  };
}

function getLatestFitness(studentId) {
  const row = get(
    `SELECT * FROM student_fitness_reports WHERE student_id = ? ORDER BY test_date DESC, created_at DESC LIMIT 1`,
    [studentId]
  );
  return formatFitnessRow(row);
}

function listFitnessHistory(studentId) {
  const rows = all(
    `SELECT * FROM student_fitness_reports WHERE student_id = ? ORDER BY test_date DESC, created_at DESC`,
    [studentId]
  );
  return rows.map(formatFitnessRow);
}

function isValidDateStr(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function saveFitnessReport(student, payload) {
  const gender = payload.gender || student.gender || 'male';
  const ageGroup = normalizeAgeGroup(payload.ageGroup || student.fitness_age_group, student.age_group);
  const testDate = payload.testDate ? String(payload.testDate).trim() : TS().slice(0, 10);
  if (!isValidDateStr(testDate)) {
    throw new HttpError(422, 'INVALID_DATE', '测评日期格式无效，应为 YYYY-MM-DD');
  }
  const evaluated = evaluateBattery(payload.raw || payload.measures || payload, {
    gender,
    ageGroup,
    legacyAge: student.age_group
  });

  const ts = TS();
  const id = newId('FIT');
  // 同步学员身上的性别/年龄段（若教练在测评时修正）
  run(
    `UPDATE students SET gender = ?, fitness_age_group = ?, fit_score = ?, updated_at = ? WHERE id = ?`,
    [evaluated.gender, evaluated.ageGroup, Math.round((evaluated.totalIndex / 20) * 10) / 10, ts, student.id]
  );

  run(
    `INSERT INTO student_fitness_reports
      (id, student_id, test_date, gender, age_group, raw_json, dimensions_json, total_index, weak_dims_json, training_hints_json, safety_notes_json, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id, student.id, testDate, evaluated.gender, evaluated.ageGroup,
      JSON.stringify(evaluated.rawStored),
      JSON.stringify(evaluated.dimensions),
      evaluated.totalIndex,
      JSON.stringify(evaluated.weakDims),
      JSON.stringify(evaluated.trainingHints),
      JSON.stringify(evaluated.safetyNotes),
      payload.note ? String(payload.note) : null,
      ts
    ]
  );
  meta.bump();
  return getLatestFitness(student.id);
}

module.exports = {
  getBattery,
  normalizeAgeGroup,
  normalizeGender,
  evaluateBattery,
  getLatestFitness,
  listFitnessHistory,
  saveFitnessReport
};
