'use strict';
const { all, get, run, transaction } = require('../db/connection');
const { newId } = require('../utils/crypto');
const { HttpError } = require('../utils/response');

const TS = () => new Date().toISOString();

function parseJson(value, fallback = {}) {
  try { return value ? JSON.parse(value) : fallback; } catch (_) { return fallback; }
}

function lessonSkillPoints(lessonNo) {
  const lesson = Number(lessonNo);
  if (!Number.isInteger(lesson) || lesson < 1 || lesson > 48) {
    throw new HttpError(422, 'VALIDATION_ERROR', '课次必须为1–48');
  }
  return all(`SELECT l.lesson_no, l.unit_no, l.lesson_type, l.skill_key, l.focus,
      l.criterion, l.sort_order, d.name AS skill_name, d.category,
      COALESCE(l.rubric_override_json, d.rubric_json) AS rubric_json,
      d.rubric_version
    FROM lesson_skill_points l
    JOIN skill_definitions d ON d.skill_key = l.skill_key AND d.deleted_at IS NULL
    WHERE l.lesson_no = ?
    ORDER BY l.sort_order, l.skill_key`, [lesson]).map(r => ({
      lessonNo: r.lesson_no, unitNo: r.unit_no, lessonType: r.lesson_type,
      skillKey: r.skill_key, skillName: r.skill_name, category: r.category,
      focus: r.focus, criterion: r.criterion, sortOrder: r.sort_order,
      rubric: parseJson(r.rubric_json), rubricVersion: r.rubric_version
    }));
}

function ensurePlanSnapshot(planId, lessonNo) {
  const existing = get('SELECT COUNT(*) AS n FROM plan_skill_points WHERE plan_id = ?', [planId]).n;
  if (existing) return existing;
  const points = lessonSkillPoints(lessonNo);
  const now = TS();
  transaction(() => {
    for (const p of points) {
      run(`INSERT INTO plan_skill_points
        (id, plan_id, skill_key, lesson_no, skill_name, focus, criterion,
         rubric_snapshot_json, rubric_version, sort_order, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [newId('PSP'), planId, p.skillKey, p.lessonNo, p.skillName, p.focus,
          p.criterion, JSON.stringify(p.rubric), p.rubricVersion, p.sortOrder, now]);
    }
  });
  return points.length;
}

function planSkillPoints(planId) {
  const plan = get('SELECT id, lesson FROM plans WHERE id = ? AND deleted_at IS NULL', [planId]);
  if (!plan) throw new HttpError(404, 'NOT_FOUND', '教学计划不存在');
  ensurePlanSnapshot(planId, plan.lesson);
  return all(`SELECT id, skill_key AS skillKey, lesson_no AS lessonNo,
      skill_name AS skillName, focus, criterion, rubric_snapshot_json AS rubricSnapshot,
      rubric_version AS rubricVersion, sort_order AS sortOrder
    FROM plan_skill_points WHERE plan_id = ? ORDER BY sort_order, skill_key`, [planId])
    .map(p => ({...p, rubric: parseJson(p.rubricSnapshot)}));
}

function sessionPlan(sessionId) {
  const session = get('SELECT id, student_id, plan_id, lesson FROM sessions WHERE id = ? AND deleted_at IS NULL', [sessionId]);
  if (!session) throw new HttpError(404, 'NOT_FOUND', '授课记录不存在');
  if (!session.plan_id) throw new HttpError(422, 'PLAN_REQUIRED', '该授课记录尚未关联教案，无法载入本堂评分项目');
  return session;
}

function sessionScores(sessionId) {
  const session = sessionPlan(sessionId);
  const points = planSkillPoints(session.plan_id);
  const scores = all(`SELECT id, plan_skill_point_id AS planSkillPointId, score,
      attempts, successes, coach_note AS coachNote, assessed_by AS assessedBy,
      assessed_at AS assessedAt
    FROM session_skill_scores WHERE session_id = ? AND deleted_at IS NULL`, [sessionId]);
  const byPoint = new Map(scores.map(s => [s.planSkillPointId, s]));
  return {
    sessionId, planId: session.plan_id, lesson: session.lesson,
    items: points.map(p => ({...p, score: byPoint.get(p.id)?.score ?? null,
      attempts: byPoint.get(p.id)?.attempts ?? null,
      successes: byPoint.get(p.id)?.successes ?? null,
      coachNote: byPoint.get(p.id)?.coachNote ?? '',
      assessedAt: byPoint.get(p.id)?.assessedAt ?? null}))
  };
}

function saveSessionScores(sessionId, input, user) {
  const session = sessionPlan(sessionId);
  if (!Array.isArray(input) || input.length > 30) {
    throw new HttpError(422, 'VALIDATION_ERROR', 'scores必须为数组，最多30项');
  }
  const allowed = new Map(planSkillPoints(session.plan_id).map(p => [p.id, p]));
  const normalized = input.map((item, index) => {
    if (!item || typeof item !== 'object') throw new HttpError(422, 'VALIDATION_ERROR', `第${index + 1}项格式错误`);
    const point = allowed.get(String(item.planSkillPointId || ''));
    if (!point) throw new HttpError(422, 'INVALID_SKILL_POINT', '评分项目不属于该授课记录关联的教案');
    const score = Number(item.score);
    if (!Number.isInteger(score) || score < 0 || score > 5) throw new HttpError(422, 'INVALID_SCORE', '评分必须为0–5整数');
    const attempts = item.attempts == null || item.attempts === '' ? null : Number(item.attempts);
    const successes = item.successes == null || item.successes === '' ? null : Number(item.successes);
    if (attempts !== null && (!Number.isInteger(attempts) || attempts < 0)) throw new HttpError(422, 'INVALID_ATTEMPTS', '尝试次数必须为非负整数');
    if (successes !== null && (!Number.isInteger(successes) || successes < 0 || attempts === null || successes > attempts)) {
      throw new HttpError(422, 'INVALID_SUCCESSES', '成功次数必须为非负整数，且不能超过已填写的尝试次数');
    }
    return { point, score, attempts, successes, coachNote: String(item.coachNote || '').slice(0, 1000) };
  });
  const now = TS();
  transaction(() => {
    for (const x of normalized) {
      run(`INSERT INTO session_skill_scores
        (id, session_id, plan_skill_point_id, score, attempts, successes, coach_note,
         rubric_snapshot_json, assessed_by, assessed_at, created_at, updated_at, deleted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
        ON CONFLICT(session_id, plan_skill_point_id) DO UPDATE SET
          score=excluded.score, attempts=excluded.attempts, successes=excluded.successes,
          coach_note=excluded.coach_note, rubric_snapshot_json=excluded.rubric_snapshot_json,
          assessed_by=excluded.assessed_by, assessed_at=excluded.assessed_at,
          updated_at=excluded.updated_at, deleted_at=NULL`,
        [newId('SSS'), sessionId, x.point.id, x.score, x.attempts, x.successes,
          x.coachNote, JSON.stringify(x.point.rubric), user?.username || user?.sub || null, now, now, now]);
    }
  });
  return sessionScores(sessionId);
}

function studentProgress(studentId) {
  const student = get('SELECT id, name FROM students WHERE id = ? AND deleted_at IS NULL', [studentId]);
  if (!student) throw new HttpError(404, 'NOT_FOUND', '学员不存在');
  const rows = all(`SELECT sss.score, sss.assessed_at AS assessedAt,
      psp.skill_key AS skillKey, psp.skill_name AS skillName, psp.lesson_no AS lessonNo,
      psp.criterion, s.lesson_date AS lessonDate, s.id AS sessionId
    FROM session_skill_scores sss
    JOIN sessions s ON s.id = sss.session_id
    JOIN plan_skill_points psp ON psp.id = sss.plan_skill_point_id
    WHERE s.student_id = ? AND s.deleted_at IS NULL AND sss.deleted_at IS NULL
    ORDER BY sss.assessed_at ASC`, [studentId]);
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.skillKey)) grouped.set(row.skillKey, []);
    grouped.get(row.skillKey).push(row);
  }
  const skills = [...grouped.entries()].map(([skillKey, history]) => {
    const recent = history.slice(-3);
    return {
      skillKey, skillName: history[history.length - 1].skillName,
      latestScore: history[history.length - 1].score,
      recentAverage: Math.round(recent.reduce((sum, x) => sum + x.score, 0) / recent.length * 100) / 100,
      trend: recent.length > 1 ? recent[recent.length - 1].score - recent[0].score : 0,
      count: history.length, history
    };
  }).sort((a, b) => a.latestScore - b.latestScore || a.skillName.localeCompare(b.skillName, 'zh-CN'));
  return { student, totalScores: rows.length, skills };
}

module.exports = { lessonSkillPoints, ensurePlanSnapshot, planSkillPoints, sessionScores, saveSessionScores, studentProgress };
