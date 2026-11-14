'use strict';
const entities = require('./entities');
const { settings, meta } = require('./misc');
const { transaction, run } = require('../db/connection');
const { HttpError } = require('../utils/response');

const DEFAULT_DEFAULTS = { minutes: 90, size: 'small', age: 'adult', freq: 2, unitsPerStage: 8, courts: 1, renewWarn: 3 };
const DEFAULT_PARAMS = {};
const DEFAULT_PREFS = { theme: 'dark', accent: 'lime', density: 'comfortable', motion: 'on' };
const DEFAULT_UI = { view: 'dash', planview: 'timeline', planForm: null, lastPlan: null, detailId: null };
const ENTITY_KEYS = ['students', 'plans', 'sessions', 'assessments'];

/** 聚合为前端可直接消费的 state（含乐观锁版本号） */
function readState() {
  const s = settings.all();
  return {
    students: entities.listAll('students'),
    plans: entities.listAll('plans'),
    sessions: entities.listAll('sessions'),
    assessments: entities.listAll('assessments'),
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
  return transaction(() => {
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
}

module.exports = { readState, replaceState, DEFAULT_DEFAULTS, DEFAULT_PARAMS, DEFAULT_PREFS, DEFAULT_UI, ENTITY_KEYS };
