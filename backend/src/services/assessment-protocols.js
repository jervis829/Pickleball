'use strict';
const { all, get, run, transaction } = require('../db/connection');
const { newId } = require('../utils/crypto');
const { HttpError } = require('../utils/response');
const TS = () => new Date().toISOString();
const json = (v, fallback = {}) => { try { return v ? JSON.parse(v) : fallback; } catch (_) { return fallback; } };

function protocolRow(row) {
  if (!row) return null;
  const criteria = all('SELECT * FROM assessment_criteria WHERE protocol_id = ? ORDER BY order_index, code', [row.id]);
  return {
    id: row.id, code: row.code, stage: row.stage, version: row.version, name: row.name,
    status: row.status, pathway: row.pathway, ageGroup: row.age_group,
    calibrationStatus: row.calibration_status, conditions: json(row.conditions_json),
    criteria: criteria.map(c => ({
      id: c.id, code: c.code, name: c.name, dimension: c.dimension,
      required: Boolean(c.is_required), gate: Boolean(c.is_gate), order: c.order_index,
      rubric: json(c.rubric_json), testProtocol: json(c.test_protocol_json),
      minTrials: c.min_trials, passRule: json(c.pass_rule_json)
    }))
  };
}

function listProtocols(query = {}) {
  const where = [], params = [];
  if (query.stage != null && query.stage !== '') {
    const stage = Number(query.stage);
    if (!Number.isInteger(stage) || stage < 1 || stage > 3) throw new HttpError(422, 'VALIDATION_ERROR', 'stage必须为1–3');
    where.push('stage = ?'); params.push(stage);
  }
  if (query.status) { where.push('status = ?'); params.push(String(query.status)); }
  return all('SELECT * FROM assessment_protocols' + (where.length ? ' WHERE ' + where.join(' AND ') : '') + ' ORDER BY stage, version DESC', params)
    .map(r => protocolRow(r));
}
function getProtocol(id) {
  const row = get('SELECT * FROM assessment_protocols WHERE id = ?', [id]);
  if (!row) throw new HttpError(404, 'NOT_FOUND', '评估协议不存在');
  return protocolRow(row);
}
function snapshotProtocol(p) {
  return JSON.stringify({ ...p, snapshotAt: TS() });
}
function createAttempt(input, user) {
  const studentId = String(input.studentId || '');
  const protocolId = String(input.protocolId || '');
  const student = get('SELECT id, name FROM students WHERE id = ? AND deleted_at IS NULL', [studentId]);
  if (!student) throw new HttpError(404, 'STUDENT_NOT_FOUND', '学员不存在');
  const protocol = getProtocol(protocolId);
  if (protocol.status !== 'published') {
    // Draft/pilot protocols may be used only to collect pilot observations, never to conclude or advance.
    if (!['draft','pilot'].includes(protocol.status)) throw new HttpError(409, 'PROTOCOL_NOT_AVAILABLE', '该协议当前不可用于新评估');
  }
  const lesson = input.lessonNumber == null || input.lessonNumber === '' ? null : Number(input.lessonNumber);
  if (lesson !== null && (!Number.isInteger(lesson) || lesson < 1 || lesson > 48)) throw new HttpError(422, 'VALIDATION_ERROR', '关联课次必须为1–48');
  const date = String(input.assessmentDate || TS().slice(0,10));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) throw new HttpError(422, 'VALIDATION_ERROR', 'assessmentDate必须为YYYY-MM-DD');
  let retestOf = input.retestOfId ? String(input.retestOfId) : null;
  if (retestOf) {
    const parent = get('SELECT * FROM assessment_attempts WHERE id = ?', [retestOf]);
    if (!parent || parent.student_id !== studentId || parent.protocol_id !== protocolId) {
      throw new HttpError(422, 'INVALID_RETEST_LINK', '复测必须关联同一学员、同一评估协议版本的原评估');
    }
  }
  const id = String(input.id || newId('AA'));
  const now = TS();
  run(`INSERT INTO assessment_attempts
    (id,student_id,protocol_id,protocol_snapshot_json,assessment_date,lesson_number,session_id,
     assessor_id,assessor_name,status,conclusion,retest_of_id,notes,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,'in_progress',NULL,?,?,?,?)`,
    [id,studentId,protocolId,snapshotProtocol(protocol),date,lesson,
      input.sessionId ? String(input.sessionId) : null,user?.sub || null,
      String(input.assessorName || user?.username || '').slice(0,100),
      retestOf,String(input.notes || '').slice(0,2000),now,now]);
  return getAttempt(id);
}
function getAttempt(id) {
  const a = get('SELECT * FROM assessment_attempts WHERE id = ?', [id]);
  if (!a) throw new HttpError(404, 'NOT_FOUND', '评估记录不存在');
  const results = all('SELECT * FROM assessment_criterion_results WHERE attempt_id = ? ORDER BY criterion_code', [id]);
  return {
    id:a.id, studentId:a.student_id, protocolId:a.protocol_id,
    protocolSnapshot:json(a.protocol_snapshot_json), assessmentDate:a.assessment_date,
    lessonNumber:a.lesson_number, sessionId:a.session_id, assessorId:a.assessor_id,
    assessorName:a.assessor_name, status:a.status, conclusion:a.conclusion,
    retestOfId:a.retest_of_id, notes:a.notes, criteriaScope:json(a.criteria_scope_json, null),
    results:results.map(r=>({id:r.id,criterionId:r.criterion_id,criterionCode:r.criterion_code,
      criterionSnapshot:json(r.criterion_snapshot_json),rawTrials:json(r.raw_trials_json,[]),
      score:r.score,achieved:r.achieved===null?null:Boolean(r.achieved),
      observations:r.observations,evidenceRef:r.evidence_ref,coachReviewStatus:r.coach_review_status||'pending',coachDecisionNote:r.coach_decision_note||''}))
  };
}
function saveResults(attemptId, input) {
  if (!Array.isArray(input) || input.length > 40) throw new HttpError(422,'VALIDATION_ERROR','results必须为数组，最多40项');
  const attempt = get('SELECT * FROM assessment_attempts WHERE id = ?', [attemptId]);
  if (!attempt) throw new HttpError(404,'NOT_FOUND','评估记录不存在');
  if (attempt.status === 'cancelled' || attempt.status === 'submitted') throw new HttpError(409,'ATTEMPT_LOCKED','已提交或取消的评估不可修改');
  const protocol = json(attempt.protocol_snapshot_json);
  const criteria = new Map((protocol.criteria || []).map(c=>[c.id,c]));
  const scope = json(attempt.criteria_scope_json, null);
  if (Array.isArray(scope) && input.some(x => !scope.includes(String(x?.criterionCode || criteria.get(String(x?.criterionId || ''))?.code || '')))) {
    throw new HttpError(422,'RETEST_SCOPE_VIOLATION','本次复测只能录入创建时指定的能力项');
  }
  const normalized = input.map((x,i)=>{
    const c = criteria.get(String(x?.criterionId || ''));
    if (!c) throw new HttpError(422,'INVALID_CRITERION','第'+(i+1)+'项不属于该评估协议快照');
    const score = x.score == null || x.score === '' ? null : Number(x.score);
    if (score !== null && (!Number.isInteger(score)||score<0||score>4)) throw new HttpError(422,'INVALID_SCORE','阶段评估分数必须为0–4整数');
    const achieved = x.achieved == null ? null : x.achieved === true ? 1 : x.achieved === false ? 0 : -1;
    if (achieved === -1) throw new HttpError(422,'INVALID_RESULT','achieved必须为布尔值或空值');
    const trials = x.rawTrials == null ? [] : x.rawTrials;
    if (!Array.isArray(trials) || trials.length > 100) throw new HttpError(422,'INVALID_TRIALS','rawTrials必须为数组，最多100条');
    return {c,score,achieved,trials,observations:String(x.observations||'').slice(0,2000),evidenceRef:String(x.evidenceRef||'').slice(0,500)};
  });
  const now=TS();
  transaction(()=>{
    for(const x of normalized) run(`INSERT INTO assessment_criterion_results
      (id,attempt_id,criterion_id,criterion_code,criterion_snapshot_json,raw_trials_json,score,achieved,observations,evidence_ref,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(attempt_id,criterion_code) DO UPDATE SET
      criterion_id=excluded.criterion_id,criterion_snapshot_json=excluded.criterion_snapshot_json,
      raw_trials_json=excluded.raw_trials_json,score=excluded.score,achieved=excluded.achieved,
      observations=excluded.observations,evidence_ref=excluded.evidence_ref,updated_at=excluded.updated_at`,
      [newId('ACR'),attemptId,x.c.id,x.c.code,JSON.stringify(x.c),JSON.stringify(x.trials),x.score,x.achieved,x.observations,x.evidenceRef,now,now]);
    run("UPDATE assessment_attempts SET status='in_progress', updated_at=? WHERE id=?",[now,attemptId]);
  });
  return getAttempt(attemptId);
}
function listStudentAttempts(studentId) {
  const student=get('SELECT id FROM students WHERE id=? AND deleted_at IS NULL',[studentId]);
  if(!student) throw new HttpError(404,'STUDENT_NOT_FOUND','学员不存在');
  return all('SELECT id FROM assessment_attempts WHERE student_id=? ORDER BY assessment_date DESC,created_at DESC',[studentId]).map(x=>getAttempt(x.id));
}
module.exports={listProtocols,getProtocol,createAttempt,getAttempt,saveResults,listStudentAttempts};
