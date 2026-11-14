'use strict';
const { run, all, get } = require('../db/connection');
const { newId } = require('../utils/crypto');
const { HttpError } = require('../utils/response');

const TS = () => new Date().toISOString();
const NUM_COLS = new Set(['stage', 'total', 'used', 'lesson', 'minutes', 'rpe', 'tech_score', 'fit_score', 'pk_level', 'racket_base']);
const JSON_COLS = new Set(['vals_json', 'zones_json']);

/** 前端字段 -> 数据库列（列名来自本文件常量，不拼接用户输入） */
const DEFS = {
  students: {
    table: 'students',
    cols: { name: 'name', phone: 'phone', age: 'age_group', stage: 'stage', sizeLabel: 'size_label', total: 'total', used: 'used', expire: 'expire_date', injury: 'injury_note', techScore: 'tech_score', fitScore: 'fit_score', pkLevel: 'pk_level', racketBase: 'racket_base', goal: 'goal', status: 'status', note: 'note' },
    defaults: { age: 'adult', stage: 1, total: 48, used: 0, status: '在训', sizeLabel: '4-6 人小班' },
    search: ['name', 'id', 'phone']
  },
  plans: {
    table: 'plans',
    cols: { lesson: 'lesson', stage: 'stage', tech: 'tech', minutes: 'minutes', date: 'lesson_date', age: 'age_group', ageName: 'age_name', size: 'class_size', zones: 'zones_json', focus: 'focus', text: 'content' },
    defaults: { minutes: 90, stage: 1, lesson: 1 },
    search: ['tech', 'age_name']
  },
  sessions: {
    table: 'sessions',
    cols: { studentId: 'student_id', date: 'lesson_date', lesson: 'lesson', minutes: 'minutes', attend: 'attend', judge: 'judge', rpe: 'rpe', note: 'note' },
    defaults: {},
    search: ['note']
  },
  assessments: {
    table: 'assessments',
    cols: { studentId: 'student_id', stage: 'stage', date: 'lesson_date', vals: 'vals_json', total: 'total', conclusion: 'conclusion' },
    defaults: { stage: 1 },
    search: ['conclusion']
  }
};

function toDb(entity, input, forcedId) {
  const def = DEFS[entity];
  const src = Object.assign({}, def.defaults, input || {});
  const row = { id: forcedId || input.id || newId(entity.slice(0, 1).toUpperCase()) };
  for (const [fe, col] of Object.entries(def.cols)) {
    let v = src[fe];
    if (JSON_COLS.has(col)) v = v == null ? null : (typeof v === 'string' ? v : JSON.stringify(v));
    else if (NUM_COLS.has(col)) v = (v === '' || v == null) ? null : Number(v);
    else v = v == null ? null : String(v);
    row[col] = (typeof v === 'number' && Number.isNaN(v)) ? null : v;
  }
  return row;
}

function fromDb(entity, row) {
  const def = DEFS[entity];
  const out = { id: row.id };
  for (const [fe, col] of Object.entries(def.cols)) {
    let v = row[col];
    if (JSON_COLS.has(col) && typeof v === 'string') { try { v = JSON.parse(v); } catch (_) { /* 保留原串 */ } }
    out[fe] = (v == null && def.defaults[fe] !== undefined) ? def.defaults[fe] : v;
  }
  out.created_at = row.created_at;
  out.updated_at = row.updated_at;
  return out;
}

function hydrate(entity, rows) {
  if (!rows.length) return [];
  let out = rows.map(r => fromDb(entity, r));
  if (entity === 'plans') {
    const ids = rows.map(r => r.id);
    const links = all(
      `SELECT ps.plan_id, ps.student_id, s.name AS student_name
         FROM plan_students ps LEFT JOIN students s ON s.id = ps.student_id
        WHERE ps.plan_id IN (${ids.map(() => '?').join(',')})`, ids);
    const map = new Map();
    for (const l of links) {
      if (!map.has(l.plan_id)) map.set(l.plan_id, { ids: [], names: [] });
      map.get(l.plan_id).ids.push(l.student_id);
      map.get(l.plan_id).names.push(l.student_name || '—');
    }
    out = out.map(o => {
      const m = map.get(o.id) || { ids: [], names: [] };
      o.studentIds = m.ids; o.studentNames = m.names;
      return o;
    });
  }
  if (entity === 'sessions' || entity === 'assessments') {
    const names = new Map(all('SELECT id, name FROM students WHERE deleted_at IS NULL').map(r => [r.id, r.name]));
    out = out.map(o => { o.studentName = o.studentId ? (names.get(o.studentId) || '—') : '—'; return o; });
  }
  return out;
}

function upsertRow(entity, row) {
  const def = DEFS[entity];
  const ts = TS();
  const cols = Object.keys(row);
  const updates = cols.filter(c => c !== 'id' && c !== 'created_at').map(c => `${c}=excluded.${c}`).join(',');
  const sql = `INSERT INTO ${def.table} (${cols.join(',')}, created_at, updated_at, deleted_at)
               VALUES (${cols.map(() => '?').join(',')}, ?, ?, NULL)
               ON CONFLICT(id) DO UPDATE SET ${updates}, updated_at=excluded.updated_at, deleted_at=NULL`;
  run(sql, [...cols.map(c => row[c]), ts, ts]);
  return row.id;
}

function listAll(entity) {
  const def = DEFS[entity];
  return hydrate(entity, all(`SELECT * FROM ${def.table} WHERE deleted_at IS NULL ORDER BY created_at ASC, id ASC`));
}

function list(entity, paging) {
  const def = DEFS[entity];
  const where = ['deleted_at IS NULL'];
  const params = [];
  if (paging.keyword) {
    where.push('(' + def.search.map(c => `${c} LIKE ?`).join(' OR ') + ')');
    def.search.forEach(() => params.push('%' + paging.keyword + '%'));
  }
  const total = get(`SELECT COUNT(*) AS c FROM ${def.table} WHERE ${where.join(' AND ')}`, params).c;
  const rows = all(`SELECT * FROM ${def.table} WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, paging.pageSize, paging.offset]);
  return { items: hydrate(entity, rows), total, page: paging.page, pageSize: paging.pageSize };
}

function find(entity, id) {
  const row = get(`SELECT * FROM ${DEFS[entity].table} WHERE id = ? AND deleted_at IS NULL`, [id]);
  if (!row) throw new HttpError(404, 'NOT_FOUND', '记录不存在');
  return hydrate(entity, [row])[0];
}

function remove(entity, id) {
  find(entity, id);
  const ts = TS();
  run(`UPDATE ${DEFS[entity].table} SET deleted_at=?, updated_at=? WHERE id=?`, [ts, ts, id]);
}

function softDeleteAll(entity) {
  const ts = TS();
  run(`UPDATE ${DEFS[entity].table} SET deleted_at=?, updated_at=? WHERE deleted_at IS NULL`, [ts, ts]);
}

/** 写入计划-学员关联；过滤不存在的学员，避免外键失败 */
function writePlanStudents(planId, ids) {
  run('DELETE FROM plan_students WHERE plan_id = ?', [planId]);
  for (const sid of Array.from(new Set(ids || []))) {
    if (!sid) continue;
    if (!get('SELECT 1 AS x FROM students WHERE id = ?', [sid])) continue;
    run('INSERT OR IGNORE INTO plan_students (plan_id, student_id) VALUES (?, ?)', [planId, sid]);
  }
}

const clearPlanStudents = () => run('DELETE FROM plan_students');

function create(entity, input) {
  const row = toDb(entity, input);
  upsertRow(entity, row);
  if (entity === 'plans') writePlanStudents(row.id, input.studentIds || []);
  return find(entity, row.id);
}

function update(entity, id, input) {
  const current = find(entity, id);
  const merged = Object.assign({}, current, input, { id });
  const row = toDb(entity, merged, id);
  upsertRow(entity, row);
  if (entity === 'plans' && input.studentIds) writePlanStudents(id, input.studentIds);
  return find(entity, id);
}

module.exports = {
  DEFS, toDb, fromDb, listAll, list, find, create, update, remove,
  upsertRow, softDeleteAll, writePlanStudents, clearPlanStudents
};
