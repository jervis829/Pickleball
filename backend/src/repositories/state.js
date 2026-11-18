'use strict';
const entities = require('./entities');
const { settings, meta } = require('./misc');
const { all } = require('../db/connection');
const { transaction, run } = require('../db/connection');
const { HttpError } = require('../utils/response');

const DEFAULT_DEFAULTS = { minutes: 90, size: 'small', age: 'adult', freq: 2, unitsPerStage: 8, courts: 1, renewWarn: 3 };
const DEFAULT_PARAMS = {};
const DEFAULT_PREFS = { theme: 'dark', accent: 'lime', density: 'comfortable', motion: 'on' };
const DEFAULT_UI = { view: 'dash', planview: 'timeline', planForm: null, lastPlan: null, detailId: null };
function readEnrollments() {
  const rows = all(`SELECT e.*, s.name AS student_name FROM enrollments e
                    LEFT JOIN students s ON s.id = e.student_id
                    WHERE e.status IN ('active','paused') ORDER BY e.start_date DESC LIMIT 200`);
  const outlines = all(`SELECT * FROM outline_lessons ORDER BY enrollment_id, seq`);
  const byEnr = new Map();
  for (const o of outlines) {
    if (!byEnr.has(o.enrollment_id)) byEnr.set(o.enrollment_id, []);
    byEnr.get(o.enrollment_id).push({
      id: o.id, seq: o.seq, unitNo: o.unit_no, lessonNo: o.lesson_no, lessonType: o.lesson_type,
      plannedDate: o.planned_date, minutes: o.minutes, focus: o.focus, status: o.status,
      sessionId: o.session_id, planId: o.plan_id, note: o.note
    });
  }
  return rows.map(r => ({
    id: r.id, studentId: r.student_id, studentName: r.student_name, packageType: r.package_type,
    className: r.class_name, totalLessons: r.total_lessons, usedLessons: r.used_lessons,
    lessonsPerWeek: r.lessons_per_week, minutesPerLesson: r.minutes_per_lesson,
    startDate: r.start_date, expireDate: r.expire_date, goal: r.goal, stage: r.stage,
    paceMode: r.pace_mode, status: r.status, outline: byEnr.get(r.id) || []
  }));
}

const ENTITY_KEYS = ['students', 'plans', 'sessions', 'assessments'];

/** 聚合为前端可直接消费的 state（含乐观锁版本号） */
function readState() {
  const s = settings.all();
  return {
    students: entities.listAll('students'),
    plans: entities.listAll('plans'),
    sessions: entities.listAll('sessions'),
    assessments: entities.listAll('assessments'),
    // P7：课程包与大纲只读下发，供前端离线时也能看「今天上哪节、点评了没」
    enrollments: readEnrollments(),
    demo: Boolean(s.meta && s.meta.demo),
    thresholds: s.thresholds || {},
    params: Object.assign({}, DEFAULT_PARAMS, s.params || {}),
    defaults: Object.assign({}, DEFAULT_DEFAULTS, s.defaults || {}),
    prefs: Object.assign({}, DEFAULT_PREFS, s.prefs || {}),
    ui: { ...DEFAULT_UI },
    revision: meta.revision()
  };
}

/**
 * 全量替换（单事务）：先软删未出现在本次快照中的记录，再 upsert 快照记录。
 * expectedRevision 用于多端并发的乐观锁；传 null 表示强制覆盖（导入/首次同步）。
 */
function replaceState(snapshot, expectedRevision = null) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new HttpError(422, 'VALIDATION_ERROR', 'state 必须是对象');
  }
  const revision = transaction(() => {
    const current = meta.revision();
    if (expectedRevision !== null && Number(expectedRevision) !== current) {
      throw new HttpError(409, 'REVISION_CONFLICT',
        `数据已在其他设备更新（服务端 revision=${current}，本次提交 revision=${expectedRevision}），请刷新后重试`);
    }

    entities.clearPlanStudents();
    for (const key of ENTITY_KEYS) entities.softDeleteAll(key);

    // 顺序关键：学员必须先于计划/记录写入，保证外键与关联可查
    for (const s of snapshot.students || []) entities.upsertRow('students', entities.toDb('students', s));
    for (const p of snapshot.plans || []) {
      const row = entities.toDb('plans', p);
      entities.upsertRow('plans', row);
      entities.writePlanStudents(row.id, p.studentIds || []);
    }
    for (const s of snapshot.sessions || []) entities.upsertRow('sessions', entities.toDb('sessions', s));
    for (const a of snapshot.assessments || []) entities.upsertRow('assessments', entities.toDb('assessments', a));

    settings.set('thresholds', snapshot.thresholds || {});
    settings.set('params', snapshot.params || DEFAULT_PARAMS);
    settings.set('defaults', snapshot.defaults || DEFAULT_DEFAULTS);
    settings.set('prefs', snapshot.prefs || DEFAULT_PREFS);
    settings.set('meta', { demo: Boolean(snapshot.demo) });

    const revision = meta.bump();
    // 清理过久的审计日志（保留最近 5000 条）
    run(`DELETE FROM audit_logs WHERE id NOT IN (SELECT id FROM audit_logs ORDER BY id DESC LIMIT 5000)`);
    return revision;
  });
  // 聚合同步/导入同样需要为新教案建立评分项目快照。
  const scoring = require('../services/skill-scoring');
  for (const plan of (snapshot.plans || [])) {
    if (plan && plan.id && plan.lesson) scoring.ensurePlanSnapshot(plan.id, plan.lesson);
  }
  return revision;
}

module.exports = { readState, replaceState, DEFAULT_DEFAULTS, DEFAULT_PARAMS, DEFAULT_PREFS, DEFAULT_UI, ENTITY_KEYS };
