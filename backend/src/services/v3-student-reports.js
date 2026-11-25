'use strict';
const { get, all, run, transaction } = require('../db/connection');
const { meta } = require('../repositories/misc');
const { HttpError } = require('../utils/response');
const { newId } = require('../utils/crypto');
const v3Curriculum = require('./v3-curriculum');
const v3Fitness = require('./v3-fitness');

const TS = () => new Date().toISOString();
const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function validateStudentFields(payload, { isCreate = false } = {}) {
  const out = {};
  if (isCreate || payload.name !== undefined) {
    const name = String(payload.name || '').trim();
    if (!name || name.length > 60) {
      throw new HttpError(422, 'INVALID_STUDENT', '学员姓名不能为空且不可超过 60 字');
    }
    out.name = name;
  }
  const strFields = [
    ['phone', 40, '手机号'],
    ['racketBg', 120, '球类基础'],
    ['target', 40, '目标水平'],
    ['injury', 500, '伤病备注'],
    ['notes', 1000, '备注']
  ];
  for (const [k, maxLen, label] of strFields) {
    const srcVal = k === 'target' ? (payload.target !== undefined ? payload.target : payload.goal) : payload[k];
    if (srcVal !== undefined) {
      const s = String(srcVal == null ? '' : srcVal).trim();
      if (s.length > maxLen) {
        throw new HttpError(422, 'INVALID_STUDENT', `${label}长度不能超过 ${maxLen} 字`);
      }
      out[k] = s;
    }
  }
  if (payload.birthYear !== undefined && payload.birthYear !== null && payload.birthYear !== '') {
    const by = Number(payload.birthYear);
    if (!Number.isInteger(by) || by < 1910 || by > new Date().getUTCFullYear()) {
      throw new HttpError(422, 'INVALID_STUDENT', '出生年份无效');
    }
    out.birthYear = by;
  } else if (payload.birthYear === '' || payload.birthYear === null) {
    out.birthYear = null;
  }
  return out;
}

function requireStudent(studentId) {
  const row = get('SELECT * FROM students WHERE id = ? AND deleted_at IS NULL', [studentId]);
  if (!row) throw new HttpError(404, 'STUDENT_NOT_FOUND', `找不到学员: ${studentId}`);
  return row;
}

function deriveLegacyAge(fitnessAgeGroup, explicitAge) {
  if (['adult', 'youth', 'senior', 'mixed'].includes(explicitAge)) return explicitAge;
  if (fitnessAgeGroup === 'u12' || fitnessAgeGroup === 'u17') return 'youth';
  if (fitnessAgeGroup === 'a50' || fitnessAgeGroup === 'a65') return 'senior';
  return 'adult';
}

function formatStudent(row) {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone || '',
    gender: row.gender || 'male',
    birthYear: row.birth_year || null,
    fitnessAgeGroup: row.fitness_age_group || 'a18',
    age: row.age_group || 'adult',
    racketBg: row.racket_bg || '',
    target: row.goal || '3.0',
    injury: row.injury_note || '',
    notes: row.note || '',
    total: row.total != null ? Number(row.total) : 48,
    used: row.used != null ? Number(row.used) : 0,
    techScore: row.tech_score != null ? Number(row.tech_score) : null,
    fitScore: row.fit_score != null ? Number(row.fit_score) : null,
    status: row.status || '在训',
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function getStudentScoreRows(studentId) {
  const rows = all('SELECT * FROM student_module_scores WHERE student_id = ?', [studentId]);
  const map = new Map();
  for (const r of rows) {
    map.set(r.module_code, {
      moduleCode: r.module_code,
      score: Number(r.score) || 0,
      practiceCount: Number(r.practice_count) || 0,
      lastPracticedAt: r.last_practiced_at || null,
      note: r.note || '',
      updatedAt: r.updated_at
    });
  }
  return map;
}

function buildModuleScoreMap(studentId) {
  const rows = getStudentScoreRows(studentId);
  const m = new Map();
  for (const [k, v] of rows.entries()) m.set(k, v.score);
  return m;
}

function getLiveAssessment(studentId, cfgInput) {
  const cfg = cfgInput || v3Curriculum.getConfig();
  const scoreRows = getStudentScoreRows(studentId);
  const scoreMap = new Map();
  for (const [k, v] of scoreRows.entries()) scoreMap.set(k, v.score);

  const summary = v3Curriculum.computeCategoryScores(scoreMap, cfg);
  const modules = (cfg.modules || []).slice().sort((a, b) => (a.seq || 0) - (b.seq || 0)).map(m => {
    const rec = scoreRows.get(m.code);
    return {
      code: m.code,
      seq: m.seq,
      title: m.title,
      track: m.track,
      categoryId: m.categoryId,
      difficulty: m.difficulty,
      score: rec ? rec.score : 0,
      practiceCount: rec ? rec.practiceCount : 0,
      lastPracticedAt: rec ? rec.lastPracticedAt : null,
      note: rec ? rec.note : ''
    };
  });

  return {
    curriculumVersion: cfg.version,
    overallScore: summary.overallScore,
    categories: summary.categories,
    modules
  };
}

function formatSnapshotRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    studentId: row.student_id,
    triggerType: row.trigger_type,
    planId: row.plan_id || null,
    planLessonId: row.plan_lesson_id || null,
    curriculumVersion: row.curriculum_version,
    overallScore: Number(row.overall_score) || 0,
    categories: JSON.parse(row.categories_json || '[]'),
    modules: JSON.parse(row.modules_json || '[]'),
    fitness: row.fitness_json ? JSON.parse(row.fitness_json) : null,
    summaryNote: row.summary_note || '',
    createdAt: row.created_at
  };
}

function captureSnapshot(studentId, opts = {}) {
  const student = requireStudent(studentId);
  const cfg = v3Curriculum.getConfig();
  const live = getLiveAssessment(student.id, cfg);
  const latestFitness = v3Fitness.getLatestFitness(student.id);
  const id = newId('SNP');
  const ts = TS();

  run(
    `INSERT INTO student_report_snapshots
      (id, student_id, trigger_type, plan_id, plan_lesson_id, curriculum_version, overall_score, categories_json, modules_json, fitness_json, summary_note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      student.id,
      opts.triggerType || 'manual',
      opts.planId || null,
      opts.planLessonId || null,
      live.curriculumVersion,
      live.overallScore,
      JSON.stringify(live.categories),
      JSON.stringify(live.modules),
      latestFitness ? JSON.stringify(latestFitness) : null,
      opts.summaryNote ? String(opts.summaryNote) : null,
      ts
    ]
  );
  meta.bump();
  return formatSnapshotRow(get('SELECT * FROM student_report_snapshots WHERE id = ?', [id]));
}

function listSnapshots(studentId) {
  requireStudent(studentId);
  const rows = all(
    `SELECT * FROM student_report_snapshots WHERE student_id = ? ORDER BY created_at DESC, rowid DESC`,
    [studentId]
  );
  return rows.map(formatSnapshotRow);
}

function compareSnapshots(studentId, newSnapId, oldSnapId) {
  const snaps = listSnapshots(studentId);
  if (!snaps.length) return { current: null, baseline: null, categoryDeltas: [], improvedModules: [], overallDelta: 0 };
  const current = newSnapId ? (snaps.find(s => s.id === newSnapId) || snaps[0]) : snaps[0];
  const prev = oldSnapId ? snaps.find(s => s.id === oldSnapId) : (snaps.length > 1 ? snaps[snaps.length - 1] : null);

  if (!prev || prev.id === current.id) {
    return {
      current,
      baseline: prev || current,
      overallDelta: 0,
      categoryDeltas: (current.categories || []).map(c => ({ id: c.id, name: c.name, current: c.score, previous: c.score, delta: 0 })),
      improvedModules: []
    };
  }

  const prevCatMap = new Map((prev.categories || []).map(c => [c.id, c.score]));
  const categoryDeltas = (current.categories || []).map(c => {
    const p = prevCatMap.has(c.id) ? Number(prevCatMap.get(c.id)) : 0;
    return {
      id: c.id,
      name: c.name,
      current: c.score,
      previous: p,
      delta: Math.round((c.score - p) * 10) / 10
    };
  });

  const prevModMap = new Map((prev.modules || []).map(m => [m.code, m.score]));
  const improvedModules = [];
  for (const m of current.modules || []) {
    const p = prevModMap.has(m.code) ? Number(prevModMap.get(m.code)) : 0;
    const d = m.score - p;
    if (d !== 0) {
      improvedModules.push({ code: m.code, title: m.title, previous: p, current: m.score, delta: d });
    }
  }

  return {
    current,
    baseline: prev,
    overallDelta: Math.round((current.overallScore - prev.overallScore) * 10) / 10,
    categoryDeltas,
    improvedModules
  };
}

function createStudentWithBaseline(payload) {
  const fields = validateStudentFields(payload, { isCreate: true });
  const name = fields.name;
  const phone = fields.phone || '';
  const gender = v3Fitness.normalizeGender(payload.gender);
  const fitnessAgeGroup = v3Fitness.normalizeAgeGroup(payload.fitnessAgeGroup || payload.ageGroup, payload.age);
  const age = deriveLegacyAge(fitnessAgeGroup, payload.age);
  const birthYear = fields.birthYear !== undefined ? fields.birthYear : null;
  const target = fields.target || '3.0';
  const racketBg = fields.racketBg || '';
  const injury = fields.injury || '';
  const notes = fields.notes || '';
  const total = payload.total != null ? Math.max(0, Math.min(999, Math.round(Number(payload.total) || 0))) : 12;

  const cfg = v3Curriculum.getConfig();
  const initialScores = payload.initialScores && typeof payload.initialScores === 'object' ? payload.initialScores : {};
  let id = newId('STU');
  if (payload.id != null && String(payload.id).trim() !== '') {
    id = String(payload.id).trim();
    if (!SAFE_ID_RE.test(id)) {
      throw new HttpError(422, 'INVALID_STUDENT', '学员 ID 格式不合法');
    }
    const dup = get('SELECT id FROM students WHERE id = ?', [id]);
    if (dup) {
      throw new HttpError(409, 'DUPLICATE_STUDENT', `学员 ID 已存在: ${id}`);
    }
  }
  const ts = TS();

  transaction(() => {
    run(
      `INSERT INTO students (id, name, phone, age_group, gender, birth_year, fitness_age_group, racket_bg, goal, injury_note, note, total, used, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '在训', ?, ?)`,
      [id, name, phone, age, gender, birthYear, fitnessAgeGroup, racketBg, target, injury, notes, total, ts, ts]
    );

    for (const m of cfg.modules || []) {
      const raw = Object.prototype.hasOwnProperty.call(initialScores, m.code) ? initialScores[m.code] : undefined;
      if (raw !== undefined && raw !== null && raw !== '' && (!Number.isFinite(Number(raw)) || Number(raw) < 0 || Number(raw) > 5)) {
        throw new HttpError(422, 'INVALID_SCORE', `模块 ${m.code} 初始评分需在 0–5 之间`);
      }
      const sc = raw != null && raw !== '' ? Math.max(0, Math.min(5, Math.round(Number(raw)))) : 0;
      run(
        `INSERT INTO student_module_scores (student_id, module_code, score, practice_count, last_practiced_at, note, updated_at)
         VALUES (?, ?, ?, 0, NULL, ?, ?)`,
        [id, m.code, sc, sc > 0 ? '建档口头沟通预填' : '', ts]
      );
    }
  });

  const live = getLiveAssessment(id, cfg);
  run('UPDATE students SET tech_score = ? WHERE id = ?', [Math.round((live.overallScore / 2) * 10) / 10, id]);

  const snapshot = captureSnapshot(id, {
    triggerType: 'baseline',
    summaryNote: payload.baselineNote ? String(payload.baselineNote).slice(0, 300) : '建档初始评分档案（口头了解初始基础，未包含场地技术测试）'
  });

  meta.bump();
  return {
    student: formatStudent(requireStudent(id)),
    assessment: live,
    latestSnapshot: snapshot
  };
}

function updateStudentProfile(studentId, payload) {
  const existing = requireStudent(studentId);
  const fields = validateStudentFields(payload, { isCreate: false });
  const name = fields.name !== undefined ? fields.name : existing.name;

  const phone = fields.phone !== undefined ? fields.phone : (existing.phone || '');
  const gender = payload.gender !== undefined ? v3Fitness.normalizeGender(payload.gender) : (existing.gender || 'male');
  const fitnessAgeGroup = payload.fitnessAgeGroup !== undefined
    ? v3Fitness.normalizeAgeGroup(payload.fitnessAgeGroup, existing.age_group)
    : (existing.fitness_age_group || 'a18');
  const age = payload.age !== undefined ? deriveLegacyAge(fitnessAgeGroup, payload.age) : deriveLegacyAge(fitnessAgeGroup, existing.age_group);
  const birthYear = fields.birthYear !== undefined ? fields.birthYear : existing.birth_year;
  const racketBg = fields.racketBg !== undefined ? fields.racketBg : (existing.racket_bg || '');
  const target = fields.target !== undefined ? fields.target : (existing.goal || '3.0');
  const injury = fields.injury !== undefined ? fields.injury : (existing.injury_note || '');
  const notes = fields.notes !== undefined ? fields.notes : (existing.note || '');
  const ts = TS();

  run(
    `UPDATE students SET name=?, phone=?, age_group=?, gender=?, birth_year=?, fitness_age_group=?, racket_bg=?, goal=?, injury_note=?, note=?, updated_at=? WHERE id=?`,
    [name, phone, age, gender, birthYear, fitnessAgeGroup, racketBg, target, injury, notes, ts, studentId]
  );
  meta.bump();
  return formatStudent(requireStudent(studentId));
}

function updateStudentScores(studentId, scoresObj, opts = {}) {
  requireStudent(studentId);
  const cfg = v3Curriculum.getConfig();
  const validCodes = new Set((cfg.modules || []).map(m => m.code));
  const ts = TS();
  const entries = Object.entries(scoresObj && typeof scoresObj === 'object' ? scoresObj : {});

  const execWrites = () => {
    for (const [code, val] of entries) {
      if (!validCodes.has(code)) continue;
      if (val === undefined || val === null || val === '') continue;
      const num = Number(val);
      if (!Number.isFinite(num) || num < 0 || num > 5) {
        throw new HttpError(422, 'INVALID_SCORE', `模块 ${code} 评分需在 0–5 之间`);
      }
      const sc = Math.max(0, Math.min(5, Math.round(num)));
      const note = opts.note ? String(opts.note).slice(0, 500) : '';
      const incPractice = opts.incrementPractice ? 1 : 0;
      const practicedAt = opts.incrementPractice ? (opts.practicedAt || ts.slice(0, 10)) : null;
      run(
        `INSERT INTO student_module_scores (student_id, module_code, score, practice_count, last_practiced_at, note, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(student_id, module_code) DO UPDATE SET
           score = excluded.score,
           practice_count = student_module_scores.practice_count + ?,
           last_practiced_at = COALESCE(?, student_module_scores.last_practiced_at),
           note = CASE WHEN excluded.note <> '' THEN excluded.note ELSE student_module_scores.note END,
           updated_at = excluded.updated_at`,
        [studentId, code, sc, incPractice, practicedAt, note, ts, incPractice, practicedAt]
      );
    }
  };
  if (opts.inTransaction) execWrites();
  else transaction(execWrites);

  const live = getLiveAssessment(studentId, cfg);
  run('UPDATE students SET tech_score = ?, updated_at = ? WHERE id = ?', [Math.round((live.overallScore / 2) * 10) / 10, ts, studentId]);
  meta.bump();
  let snapshot = null;
  if (opts.createSnapshot) {
    snapshot = captureSnapshot(studentId, {
      triggerType: opts.triggerType || 'manual',
      planId: opts.planId || null,
      planLessonId: opts.planLessonId || null,
      summaryNote: opts.summaryNote || '教练手动更新技术评分并留存快照'
    });
  }
  return { assessment: live, snapshot };
}

function getStudentFullReport(studentId) {
  const row = requireStudent(studentId);
  const student = formatStudent(row);
  const cfg = v3Curriculum.getConfig();
  const live = getLiveAssessment(student.id, cfg);
  const snapshots = listSnapshots(student.id);
  const latestFitness = v3Fitness.getLatestFitness(student.id);
  const fitnessHistory = v3Fitness.listFitnessHistory(student.id);
  const comparison = snapshots.length ? compareSnapshots(student.id, snapshots[0].id, snapshots[snapshots.length - 1].id) : null;

  return {
    student,
    latestSnapshot: snapshots[0] || null,
    liveAssessment: live,
    snapshots,
    comparison,
    latestFitness,
    fitnessHistory
  };
}

function listStudentsOverview() {
  const rows = all('SELECT * FROM students WHERE deleted_at IS NULL ORDER BY created_at DESC');
  const cfg = v3Curriculum.getConfig();
  return rows.map(r => {
    const stu = formatStudent(r);
    const live = getLiveAssessment(stu.id, cfg);
    const latestFitness = v3Fitness.getLatestFitness(stu.id);
    const latestSnapRow = get(
      'SELECT id, trigger_type, overall_score, created_at FROM student_report_snapshots WHERE student_id = ? ORDER BY created_at DESC LIMIT 1',
      [stu.id]
    );
    return {
      ...stu,
      overallScore: live.overallScore,
      categories: live.categories,
      learnedCount: live.modules.filter(m => m.score >= 1).length,
      masteredCount: live.modules.filter(m => m.score >= 2).length,
      totalModules: live.modules.length,
      latestFitnessIndex: latestFitness ? latestFitness.totalIndex : null,
      latestSnapshot: latestSnapRow ? {
        id: latestSnapRow.id,
        triggerType: latestSnapRow.trigger_type,
        overallScore: latestSnapRow.overall_score,
        createdAt: latestSnapRow.created_at
      } : null
    };
  });
}

module.exports = {
  requireStudent,
  formatStudent,
  getLiveAssessment,
  captureSnapshot,
  listSnapshots,
  compareSnapshots,
  createStudentWithBaseline,
  updateStudentProfile,
  updateStudentScores,
  getStudentFullReport,
  listStudentsOverview
};
