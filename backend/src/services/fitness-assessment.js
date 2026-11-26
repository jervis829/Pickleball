'use strict';
/**
 * 身体素质测评服务：版本化测评表快照 + 单项原始值 + 图文报告 + 计划适配建议。
 * 与阶段能力评估（assessment_protocols）保持同一口径：
 *   - 快照固化：规则/分档改动不会重写历史报告
 *   - 未测不当作 0 分
 *   - 教练确认后才回写学员档案的入班体能分（fit_score），不自动晋级、不自动减量到危险线以下
 */
const fs = require('node:fs');
const path = require('node:path');
const { all, get, run, transaction } = require('../db/connection');
const { newId } = require('../utils/crypto');
const { HttpError } = require('../utils/response');
const config = require('../config');
const scoring = require('./fitness-scoring');

const TS = () => new Date().toISOString();
const json = (v, fallback = {}) => { try { return v ? JSON.parse(v) : fallback; } catch (_) { return fallback; } };

let cachedSpec = null;
function loadSpec() {
  if (cachedSpec) return cachedSpec;
  const file = path.join(config.ROOT, 'database', 'seeds', 'fitness-battery.json');
  if (!fs.existsSync(file)) throw new HttpError(500, 'BATTERY_MISSING', '专业测评表未安装：缺少 database/seeds/fitness-battery.json');
  cachedSpec = JSON.parse(fs.readFileSync(file, 'utf8'));
  return cachedSpec;
}

const STATUSES = ['measured', 'aborted', 'skipped', 'contraindicated'];
const SEXES = ['male', 'female'];

/** 测评表定义（前端据此渲染测试卡与录入表单） */
function battery() {
  const spec = loadSpec();
  return {
    code: spec.code, version: spec.version, status: spec.status, name: spec.name,
    durationMinutes: spec.durationMinutes, staff: spec.staff, equipment: spec.equipment,
    orderPolicy: spec.orderPolicy, safetyGeneral: spec.safetyGeneral,
    calibrationNote: spec.calibrationNote, factorNote: spec.factorNote, sexFactorNote: spec.sexFactorNote,
    // factor / dimensionFactor 必须一并下发：否则调用方（前端即时预览、报表）会静默丢失年龄组让步
    ageGroups: spec.ageGroups.map(g => ({
      code: g.code, name: g.name, minAge: g.minAge, maxAge: g.maxAge,
      factor: g.factor, rpeCap: g.rpeCap, dimensionFactor: g.dimensionFactor || {}, note: g.note
    })),
    dimensions: Object.entries(spec.weights).map(([code, weight]) => ({
      code, weight,
      name: (spec.dimensions[code] || {}).name || code,
      pickleball: (spec.dimensions[code] || {}).pickleball || '',
      advice: (spec.planMapping || {})[code] || ''
    })),
    fitScoreBands: spec.fitScoreBands,
    items: spec.items.map(i => ({
      code: i.code, no: i.no, name: i.name, en: i.en, dimension: i.dimension,
      unit: i.unit, direction: i.direction, trials: i.trials, protocol: i.protocol,
      safety: i.safety, anchors: i.anchors, sexFactor: i.sexFactor || {},
      altAnchorsByVariant: i.altAnchorsByVariant || {}, variants: i.variants || []
    }))
  };
}

const levelOf = v => scoring.levelFromIndex(v);

/** 把一行 + 结果行 + 快照 组装成完整报告 */
function buildReport(row) {
  const snap = json(row.battery_snapshot_json);
  const results = all(`SELECT * FROM fitness_results WHERE assessment_id = ? ORDER BY item_code`, [row.id])
    .map(r => ({
      itemCode: r.item_code, itemName: r.item_name, dimension: r.dimension,
      variantCode: r.variant_code, variantName: r.variant_name,
      unit: r.unit, direction: r.direction,
      rawValue: r.raw_value, trials: json(r.trials_json, []),
      status: r.status, level: r.level, indexValue: r.index_value, note: r.note || ''
    }));
  const ageGroup = (snap.ageGroups || []).find(g => g.code === row.age_group_code) ||
    { code: row.age_group_code, name: row.age_group_name, factor: row.age_factor, rpeCap: 4, dimensionFactor: {} };
  const report = scoring.computeReport(snap, {
    age: snap.age, sex: row.sex, ageGroupCode: row.age_group_code, results
  });
  const advice = scoring.planAdvice(snap, report);
  return {
    id: row.id, studentId: row.student_id, batteryCode: row.battery_code, batteryVersion: row.battery_version,
    testDate: row.test_date, status: row.status, sex: row.sex,
    heightCm: row.height_cm, weightKg: row.weight_kg,
    notes: row.notes || '', assessedByName: row.assessed_by_name || '',
    completedAt: row.completed_at, createdAt: row.created_at, updatedAt: row.updated_at,
    ageGroup: { code: ageGroup.code, name: ageGroup.name, factor: ageGroup.factor, rpeCap: ageGroup.rpeCap },
    stored: { totalIndex: row.total_index, fitScore: row.fit_score, fitScoreLabel: row.fit_score_label },
    report,
    advice
  };
}

function studentRow(studentId) {
  const s = get('SELECT id, name, age_group, fit_score, tech_score, injury_note FROM students WHERE id = ? AND deleted_at IS NULL', [studentId]);
  if (!s) throw new HttpError(404, 'STUDENT_NOT_FOUND', '学员不存在');
  return s;
}

/** 学员年龄段 → 测评年龄组（用于缺省与安全上限） */
function defaultAgeGroupCode(ageGroup) {
  const spec = loadSpec();
  const map = { youth: 'u17', adult: 'a18', senior: 'a55', mixed: 'a18' };
  return spec.ageGroups.some(g => g.code === map[ageGroup]) ? map[ageGroup] : 'a18';
}

function createAssessment(input, user) {
  const student = studentRow(String(input.studentId || ''));
  const spec = loadSpec();
  const ageGroupCode = input.ageGroupCode || defaultAgeGroupCode(student.age_group);
  const ageGroup = spec.ageGroups.find(g => g.code === ageGroupCode);
  if (!ageGroup) throw new HttpError(422, 'VALIDATION_ERROR', '年龄组不合法：' + ageGroupCode);
  const sex = input.sex == null || input.sex === '' ? null : String(input.sex);
  if (sex != null && !SEXES.includes(sex)) throw new HttpError(422, 'VALIDATION_ERROR', '性别只能为 male / female 或留空');
  const date = String(input.testDate || TS().slice(0, 10));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
    throw new HttpError(422, 'VALIDATION_ERROR', 'testDate 必须为 YYYY-MM-DD');
  }
  const num = (v, min, max, label) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(422, 'VALIDATION_ERROR', `${label}须在 ${min}–${max} 之间`);
    return n;
  };
  const height = num(input.heightCm, 80, 230, '身高');
  const weight = num(input.weightKg, 20, 250, '体重');

  const id = String(input.id || newId('FIT'));
  const now = TS();
  const snapshot = JSON.stringify(Object.assign({}, spec, { age: null, snapshottedAt: now }));
  run(`INSERT INTO fitness_assessments
    (id, student_id, battery_code, battery_version, battery_snapshot_json, test_date,
     age_group_code, age_group_name, age_factor, sex, height_cm, weight_kg, status,
     total_index, fit_score, fit_score_label, notes, assessed_by, assessed_by_name, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'draft',NULL,NULL,NULL,?,?,?,?,?)`,
    [id, student.id, spec.code, spec.version, snapshot, date,
      ageGroup.code, ageGroup.name, ageGroup.factor, sex, height, weight,
      String(input.notes || '').slice(0, 2000), user?.sub || null,
      String(input.assessedByName || user?.username || '').slice(0, 100), now, now]);
  // 预建 9 个结果行（状态 skipped，表示尚未测试），保证报告能显示「未测」而不是缺失
  for (const item of spec.items) {
    run(`INSERT OR IGNORE INTO fitness_results
      (id, assessment_id, item_code, item_name, dimension, variant_code, variant_name,
       unit, direction, raw_value, trials_json, status, note, created_at, updated_at)
      VALUES (?,?,?,?,?,NULL,NULL,?,?,NULL,'[]','skipped','',?,?)`,
      [newId('FIR'), id, item.code, item.name, item.dimension, item.unit, item.direction, now, now]);
  }
  return getAssessment(id);
}

function validateScope(assessmentId) {
  const row = get('SELECT * FROM fitness_assessments WHERE id = ?', [assessmentId]);
  if (!row) throw new HttpError(404, 'NOT_FOUND', '体能测评记录不存在');
  if (row.status === 'completed') throw new HttpError(409, 'ASSESSMENT_LOCKED', '已完成的测评不可再修改；如需复测请新建一份');
  return row;
}

/**
 * 保存单项结果。
 * input: [{ itemCode, rawValue?, trials?, variantCode?, status?, note? }]
 * 注意：这里的语义是「本次提交的项」，未提交的项保留原值。
 */
function saveResults(assessmentId, input, user) {
  if (!Array.isArray(input) || input.length > 20) throw new HttpError(422, 'VALIDATION_ERROR', 'results 必须为数组，最多 20 项');
  const row = validateScope(assessmentId);
  const spec = json(row.battery_snapshot_json);
  const ageGroup = (spec.ageGroups || []).find(g => g.code === row.age_group_code) || { factor: 1, dimensionFactor: {} };
  const now = TS();
  const scored = [];
  input.forEach((item, i) => {
    if (!item || typeof item !== 'object') throw new HttpError(422, 'VALIDATION_ERROR', `第 ${i + 1} 项格式错误`);
    const status = item.status || 'measured';
    if (!STATUSES.includes(status)) throw new HttpError(422, 'VALIDATION_ERROR', `第 ${i + 1} 项状态不合法`);
    let result;
    try {
      result = scoring.scoreItem(spec, {
        itemCode: item.itemCode, itemNo: item.itemNo,
        rawValue: item.rawValue, trials: item.trials, variantCode: item.variantCode,
        status, note: item.note
      }, { ageGroup, sex: row.sex });
    } catch (e) {
      throw new HttpError(422, e.code === 'UNKNOWN_ITEM' ? 'UNKNOWN_ITEM' : 'INVALID_VALUE', e.message);
    }
    if (status === 'measured' && result.rawValue == null) {
      throw new HttpError(422, 'INVALID_VALUE', `「${result.itemName}」已标记为实测，但未填写实测值`);
    }
    scored.push(result);
  });

  transaction(() => {
    for (const r of scored) {
      run(`INSERT INTO fitness_results
        (id, assessment_id, item_code, item_name, dimension, variant_code, variant_name,
         unit, direction, raw_value, trials_json, status, level, index_value, note, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(assessment_id, item_code) DO UPDATE SET
          variant_code=excluded.variant_code, variant_name=excluded.variant_name,
          unit=excluded.unit, direction=excluded.direction, raw_value=excluded.raw_value,
          trials_json=excluded.trials_json, status=excluded.status, level=excluded.level,
          index_value=excluded.index_value, note=excluded.note, updated_at=excluded.updated_at`,
        [newId('FIR'), assessmentId, r.itemCode, r.itemName, r.dimension,
          r.variantCode, r.variantName, r.unit, r.direction, r.rawValue,
          JSON.stringify(r.trials || []), r.status, r.level, r.indexValue, r.note, now, now]);
    }
    // 草稿阶段也把当前指数存下来，方便列表页显示进度（完成后以 finalize 的结果为准）
    const draft = buildReport(Object.assign({}, row, { updated_at: now }));
    run('UPDATE fitness_assessments SET total_index=?, fit_score=?, fit_score_label=?, updated_at=? WHERE id=?',
      [draft.report.totalIndex, draft.report.fitScore, draft.report.fitScoreLabel, now, assessmentId]);
  });
  return getAssessment(assessmentId);
}

/**
 * 完成测评：至少覆盖 6 项（含 4 个不同维度）才允许完成，避免缺项过多导致雷达图失真。
 * 完成后锁定，只能新建复测。
 */
function finalizeAssessment(assessmentId, input, user) {
  const row = validateScope(assessmentId);
  const spec = json(row.battery_snapshot_json);
  const measured = all(`SELECT dimension FROM fitness_results WHERE assessment_id=? AND status='measured'`, [assessmentId]);
  const dims = new Set(measured.map(r => r.dimension));
  if (measured.length < 6 || dims.size < 4) {
    throw new HttpError(422, 'INCOMPLETE_BATTERY',
      `至少需要完成 6 个项目且覆盖 4 个身体维度才能生成报告（当前 ${measured.length} 项 / ${dims.size} 个维度）。未测项目不会被当作 0 分。`);
  }
  const now = TS();
  const report = buildReport(Object.assign({}, row, { sex: row.sex }));
  const notes = input && input.notes != null ? String(input.notes).slice(0, 2000) : row.notes;
  run(`UPDATE fitness_assessments
    SET status='completed', total_index=?, fit_score=?, fit_score_label=?, notes=?,
        assessed_by=?, assessed_by_name=?, completed_at=?, updated_at=?
    WHERE id=?`,
    [report.report.totalIndex, report.report.fitScore, report.report.fitScoreLabel, notes,
      user?.sub || row.assessed_by, row.assessed_by_name || (user?.username || ''),
      now, now, assessmentId]);
  return getAssessment(assessmentId);
}

function getAssessment(id) {
  const row = get('SELECT * FROM fitness_assessments WHERE id = ?', [id]);
  if (!row) throw new HttpError(404, 'NOT_FOUND', '体能测评记录不存在');
  const out = buildReport(row);
  const student = get('SELECT id, name, age_group, fit_score, tech_score, injury_note FROM students WHERE id = ?', [row.student_id]);
  out.student = student
    ? { id: student.id, name: student.name, ageGroup: student.age_group, fitScore: student.fit_score, injury: student.injury_note || '' }
    : null;
  out.comparison = scoring.compareWithCoachScore(out.report, student ? student.fit_score : null);
  return out;
}

/** 学员历史测评（含趋势点，供报告页画折线） */
function listStudentAssessments(studentId) {
  studentRow(studentId);
  const rows = all(`SELECT id, test_date, status, total_index, fit_score, fit_score_label, age_group_code, age_group_name
    FROM fitness_assessments WHERE student_id = ? ORDER BY test_date DESC, created_at DESC`, [studentId]);
  const trend = rows.filter(r => r.status === 'completed' && r.total_index != null)
    .map(r => ({ id: r.id, date: r.test_date, totalIndex: r.total_index, fitScore: r.fit_score }))
    .reverse();
  return {
    items: rows.map(r => ({
      id: r.id, testDate: r.test_date, status: r.status,
      totalIndex: r.total_index, fitScore: r.fit_score, fitScoreLabel: r.fit_score_label,
      ageGroup: { code: r.age_group_code, name: r.age_group_name }
    })),
    trend
  };
}

/** 最新一份已完成报告（供教案生成 / 首页提醒使用） */
function latestCompleted(studentId) {
  const row = get(`SELECT id FROM fitness_assessments
    WHERE student_id = ? AND status = 'completed'
    ORDER BY test_date DESC, created_at DESC LIMIT 1`, [studentId]);
  return row ? getAssessment(row.id) : null;
}

/**
 * 教练确认后把报告结果写回学员档案：
 *  - fit_score（入班体能 0-5）
 *  - 同时在 notes 里留痕，不做任何自动晋级
 */
function applyToStudentProfile(assessmentId, input, user) {
  const assessment = getAssessment(assessmentId);
  if (assessment.status !== 'completed') throw new HttpError(409, 'NOT_COMPLETED', '只有已完成的测评才能写入学员档案');
  const reported = assessment.report.fitScore;
  if (reported == null) throw new HttpError(409, 'NO_SCORE', '本次测评不足以生成体能分（有效项目不足）');
  const override = input && input.fitScore != null && input.fitScore !== '' ? Number(input.fitScore) : null;
  if (override != null && (!Number.isInteger(override) || override < 0 || override > 5)) {
    throw new HttpError(422, 'VALIDATION_ERROR', '覆盖的体能分必须为 0–5 整数');
  }
  const finalScore = override == null ? reported : override;
  const now = TS();
  transaction(() => {
    run('UPDATE students SET fit_score = ?, updated_at = ? WHERE id = ?', [finalScore, now, assessment.studentId]);
  });
  return {
    studentId: assessment.studentId,
    fitScore: finalScore,
    reportedScore: reported,
    overridden: override != null && override !== reported,
    note: '已写入学员档案的入班体能分；本次测评与报告保持原样，不被改写。'
  };
}

module.exports = {
  battery, createAssessment, saveResults, finalizeAssessment, getAssessment,
  listStudentAssessments, latestCompleted, applyToStudentProfile, loadSpec
};
