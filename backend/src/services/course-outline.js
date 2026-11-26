'use strict';
/**
 * P7 课程包 / 课程大纲 / 课次执行 / 课后点评服务
 *
 * 设计原则：
 *   - 课次执行必须是「一次点击、一个事务」：创建会话、标记大纲课次已授课、
 *     累加课程包已用课次、回写学员已耗课次。中途失败整体回滚，不留半条记录。
 *   - 幂等：同一大纲课次重复点「执行」不会生成第二条授课记录。
 *   - 不改 48 课次主线：只读 LESSONS 表产出排课，不写回课程体系。
 */
const fs = require('node:fs');
const path = require('node:path');
const { all, get, run, transaction } = require('../db/connection');
const { newId } = require('../utils/crypto');
const { HttpError } = require('../utils/response');
const config = require('../config');
const engine = require('./outline-engine');

const TS = () => new Date().toISOString();
const json = (v, fallback = null) => { try { return v ? JSON.parse(v) : fallback; } catch (_) { return fallback; } };

let cachedDifficulty = null;
function loadDifficulty() {
  if (cachedDifficulty) return cachedDifficulty;
  const file = path.join(config.ROOT, 'database', 'seeds', 'curriculum-difficulty.json');
  if (!fs.existsSync(file)) throw new HttpError(500, 'DIFFICULTY_MISSING', '难度表未安装：缺少 database/seeds/curriculum-difficulty.json');
  cachedDifficulty = JSON.parse(fs.readFileSync(file, 'utf8'));
  // 补上单元标题，便于前端直接显示
  const tech = new Map(all('SELECT unit_no, tech FROM curriculum_units').map(r => [Number(r.unit_no), r.tech]));
  cachedDifficulty.units = cachedDifficulty.units.map(u => Object.assign({}, u, { tech: tech.get(Number(u.u)) || '' }));
  return cachedDifficulty;
}

const PACKAGE_TYPES = ['solo', 'small', 'large'];
const PACE_MODES = ['fixed', 'adaptive'];
const OUTLINE_STATUSES = ['planned', 'taught', 'reviewed', 'skipped'];

function ensureStudent(studentId) {
  const s = get('SELECT * FROM students WHERE id = ? AND deleted_at IS NULL', [studentId]);
  if (!s) throw new HttpError(404, 'STUDENT_NOT_FOUND', '学员不存在');
  return s;
}

function mapEnrollment(r) {
  const outline = all('SELECT * FROM outline_lessons WHERE enrollment_id = ? ORDER BY seq ASC', [r.id]);
  return {
    id: r.id, studentId: r.student_id, packageType: r.package_type, className: r.class_name,
    totalLessons: r.total_lessons, usedLessons: r.used_lessons, lessonsPerWeek: r.lessons_per_week,
    minutesPerLesson: r.minutes_per_lesson, startDate: r.start_date, expireDate: r.expire_date,
    goal: r.goal, stage: r.stage, paceMode: r.pace_mode, status: r.status, note: r.note,
    createdAt: r.created_at, updatedAt: r.updated_at,
    progress: {
      total: outline.length || r.total_lessons,
      taught: outline.filter(x => x.status === 'taught' || x.status === 'reviewed').length,
      reviewed: outline.filter(x => x.status === 'reviewed').length,
      planned: outline.filter(x => x.status === 'planned').length
    }
  };
}

function mapOutline(r) {
  return {
    id: r.id, enrollmentId: r.enrollment_id, seq: r.seq, unitNo: r.unit_no, lessonNo: r.lesson_no,
    lessonType: r.lesson_type, plannedDate: r.planned_date, minutes: r.minutes, focus: r.focus,
    status: r.status, planId: r.plan_id, sessionId: r.session_id,
    pace: json(r.pace_json, {}), note: r.note
  };
}

/** 创建课程包 + 生成大纲（单事务） */
function createEnrollment(body, user) {
  const studentId = String(body.studentId || '').trim();
  if (!studentId) throw new HttpError(422, 'VALIDATION_ERROR', 'studentId 必填', [{ field: 'studentId', message: '必填项' }]);
  const student = ensureStudent(studentId);

  const total = Number(body.totalLessons);
  if (!Number.isInteger(total) || total < 1 || total > 200) {
    throw new HttpError(422, 'VALIDATION_ERROR', 'totalLessons 必须是 1-200 的整数', [{ field: 'totalLessons', message: '范围 1-200' }]);
  }
  const packageType = PACKAGE_TYPES.includes(body.packageType) ? body.packageType : (student.size_label === '私教 1 人' ? 'solo' : 'small');
  if (packageType === 'solo' && student.size_label && student.size_label !== '私教 1 人') {
    // 不阻断：允许把班课学员单独开私教包，只记录备注
  }
  const paceMode = PACE_MODES.includes(body.paceMode) ? body.paceMode : 'adaptive';
  const startDate = /^\d{4}-\d{2}-\d{2}$/.test(String(body.startDate || '')) ? body.startDate : new Date().toISOString().slice(0, 10);

  const difficulty = loadDifficulty();
  const outline = engine.buildOutline({
    difficulty,
    totalLessons: total,
    startStage: body.startStage != null ? Number(body.startStage) : Number(student.stage) || 1,
    startUnit: body.startUnit != null ? Number(body.startUnit) : undefined,
    techLevel: body.techLevel != null ? Number(body.techLevel) : (student.tech_score == null ? 3 : Number(student.tech_score)),
    fitLevel: body.fitLevel != null ? Number(body.fitLevel) : (student.fit_score == null ? 3 : Number(student.fit_score)),
    ageGroup: body.ageGroup || student.age_group || 'adult',
    minutes: body.minutesPerLesson != null ? Number(body.minutesPerLesson) : 90,
    paceMode,
    lessonsPerWeek: body.lessonsPerWeek != null ? Number(body.lessonsPerWeek) : 2,
    startDate
  });

  const id = newId('E');
  const ts = TS();
  transaction(() => {
    run(`INSERT INTO enrollments
      (id, student_id, package_type, class_name, total_lessons, used_lessons, lessons_per_week, minutes_per_lesson,
       start_date, expire_date, goal, stage, pace_mode, status, note, created_at, updated_at)
      VALUES (?,?,?,?,?,0,?,?,?,?,?,?,?, 'active', ?, ?, ?)`,
    [id, studentId, packageType, body.className || student.size_label || null, total,
      Math.max(1, Math.min(7, Number(body.lessonsPerWeek) || 2)), Number(body.minutesPerLesson) || 90,
      startDate, body.expireDate || null, body.goal || student.goal || null,
      Math.max(1, Math.min(3, Number(body.startStage) || Number(student.stage) || 1)),
      paceMode, body.note || null, ts, ts]);
    for (const row of outline.rows) {
      run(`INSERT INTO outline_lessons
        (id, enrollment_id, seq, unit_no, lesson_no, lesson_type, planned_date, minutes, focus, status, pace_json, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?, 'planned', ?, ?, ?)`,
      [newId('OL'), id, row.seq, row.unit_no, row.lesson_no, row.lesson_type, row.planned_date, row.minutes,
        row.lesson_type === 'R' ? '同单元补强：只练未达标判据' : null,
        JSON.stringify(row.pace || {}), ts, ts]);
    }
  });

  const saved = get('SELECT * FROM enrollments WHERE id = ?', [id]);
  return Object.assign(mapEnrollment(saved), {
    outline: all('SELECT * FROM outline_lessons WHERE enrollment_id = ? ORDER BY seq ASC', [id]).map(mapOutline),
    generated: {
      byUnit: outline.byUnit, truncated: outline.truncated, truncatedReason: outline.truncatedReason,
      note: outline.note, ctx: outline.ctx, lessonsPerWeek: outline.lessonsPerWeek,
      model: outline.model, calibrationNote: difficulty.calibrationNote
    }
  });
}

function getEnrollment(id) {
  const r = get('SELECT * FROM enrollments WHERE id = ?', [id]);
  if (!r) throw new HttpError(404, 'ENROLLMENT_NOT_FOUND', '课程包不存在');
  const student = get('SELECT id, name, age_group, stage, tech_score, fit_score, injury_note, goal FROM students WHERE id = ?', [r.student_id]);
  return Object.assign(mapEnrollment(r), {
    student: student ? {
      id: student.id, name: student.name, ageGroup: student.age_group, stage: student.stage,
      techScore: student.tech_score, fitScore: student.fit_score, injury: student.injury_note, goal: student.goal
    } : null,
    outline: all('SELECT * FROM outline_lessons WHERE enrollment_id = ? ORDER BY seq ASC', [id]).map(mapOutline)
  });
}

function listEnrollments(query) {
  const where = ['1=1'];
  const params = [];
  if (query.studentId) { where.push('e.student_id = ?'); params.push(String(query.studentId)); }
  if (query.status) { where.push('e.status = ?'); params.push(String(query.status)); }
  const rows = all(`SELECT e.*, s.name AS student_name FROM enrollments e
                    LEFT JOIN students s ON s.id = e.student_id
                    WHERE ${where.join(' AND ')} ORDER BY e.start_date DESC, e.created_at DESC LIMIT 200`, params);
  // 列表同样返回大纲：课程包页要用它渲染逐节状态与「备课」入口
  return rows.map(r => Object.assign(mapEnrollment(r), {
    studentName: r.student_name,
    outline: all('SELECT * FROM outline_lessons WHERE enrollment_id = ? ORDER BY seq ASC', [r.id]).map(mapOutline)
  }));
}

function updateEnrollment(id, body) {
  const r = get('SELECT * FROM enrollments WHERE id = ?', [id]);
  if (!r) throw new HttpError(404, 'ENROLLMENT_NOT_FOUND', '课程包不存在');
  const fields = {
    className: 'class_name', goal: 'goal', note: 'note', expireDate: 'expire_date',
    status: 'status', paceMode: 'pace_mode', lessonsPerWeek: 'lessons_per_week', minutesPerLesson: 'minutes_per_lesson'
  };
  const sets = [];
  const params = [];
  for (const [k, col] of Object.entries(fields)) {
    if (body[k] === undefined) continue;
    if (k === 'status' && !['active', 'completed', 'paused', 'cancelled'].includes(body[k])) {
      throw new HttpError(422, 'VALIDATION_ERROR', 'status 取值不合法');
    }
    if (k === 'paceMode' && !PACE_MODES.includes(body[k])) throw new HttpError(422, 'VALIDATION_ERROR', 'paceMode 取值不合法');
    sets.push(`${col} = ?`); params.push(body[k]);
  }
  if (sets.length) {
    run(`UPDATE enrollments SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, [...params, TS(), id]);
  }
  return getEnrollment(id);
}

/**
 * 执行一节课：把大纲里的某一节变成「已授课」记录，并可立即带入点评字段。
 * 幂等：若该大纲课次已有关联 session，直接返回既有 session，不重复建记录。
 */
function startLesson(enrollmentId, body, user) {
  const enroll = get('SELECT * FROM enrollments WHERE id = ?', [enrollmentId]);
  if (!enroll) throw new HttpError(404, 'ENROLLMENT_NOT_FOUND', '课程包不存在');
  if (enroll.status === 'cancelled') throw new HttpError(409, 'ENROLLMENT_CANCELLED', '课程包已取消，不能继续排课');

  const outlineId = body.outlineLessonId ? String(body.outlineLessonId) : null;
  let ol = null;
  if (outlineId) {
    ol = get('SELECT * FROM outline_lessons WHERE id = ? AND enrollment_id = ?', [outlineId, enrollmentId]);
    if (!ol) throw new HttpError(404, 'OUTLINE_NOT_FOUND', '该课程包里没有这一节课');
  } else {
    ol = get(`SELECT * FROM outline_lessons WHERE enrollment_id = ? AND status = 'planned' ORDER BY seq ASC LIMIT 1`, [enrollmentId]);
    if (!ol) throw new HttpError(409, 'NO_PLANNED_LESSON', '该课程包没有待上的课次（可能已全部完成）');
  }
  if (ol.session_id) {
    const existing = get('SELECT * FROM sessions WHERE id = ?', [ol.session_id]);
    if (existing) {
      return { session: mapSession(existing), outlineLesson: mapOutline(ol), duplicated: true };
    }
  }
  const student = ensureStudent(enroll.student_id);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || '')) ? body.date : new Date().toISOString().slice(0, 10);
  const sessionId = newId('R');
  const ts = TS();
  const planId = body.planId ? String(body.planId) : null;

  transaction(() => {
    run(`INSERT INTO sessions
      (id, student_id, plan_id, enrollment_id, outline_lesson_id, lesson_date, lesson, minutes, attend, judge, rpe, note,
       review_status, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'pending', ?, ?)`,
    [sessionId, student.id, planId, enrollmentId, ol.id, date, ol.lesson_no, ol.minutes,
      body.attend || '出勤', body.judge || '部分达标', body.rpe == null ? null : Number(body.rpe), body.note || null, ts, ts]);
    run(`UPDATE outline_lessons SET status = 'taught', session_id = ?, plan_id = COALESCE(?, plan_id), updated_at = ? WHERE id = ?`,
      [sessionId, planId, ts, ol.id]);
    run(`UPDATE enrollments SET used_lessons = used_lessons + 1, updated_at = ? WHERE id = ?`, [ts, enrollmentId]);
    // 学员已耗课次同步（不超过已购课次上限，避免出现 49/48）
    run(`UPDATE students SET used = MIN(COALESCE(total, 48), COALESCE(used, 0) + 1), updated_at = ? WHERE id = ?`, [ts, student.id]);
  });

  const session = get('SELECT * FROM sessions WHERE id = ?', [sessionId]);
  const olAfter = get('SELECT * FROM outline_lessons WHERE id = ?', [ol.id]);
  return {
    session: mapSession(session),
    outlineLesson: mapOutline(olAfter),
    duplicated: false,
    nextStep: engine.nextLessonAdvice(
      { rows: all('SELECT * FROM outline_lessons WHERE enrollment_id = ? ORDER BY seq ASC', [enrollmentId]).map(mapOutline), paceMode: enroll.pace_mode },
      ol.seq, body.judge || '部分达标'
    )
  };
}

function mapSession(r) {
  return {
    id: r.id, studentId: r.student_id, planId: r.plan_id, enrollmentId: r.enrollment_id,
    outlineLessonId: r.outline_lesson_id, date: r.lesson_date, lesson: r.lesson, minutes: r.minutes,
    attend: r.attend, judge: r.judge, rpe: r.rpe, note: r.note,
    reviewStatus: r.review_status, reviewedAt: r.reviewed_at,
    judgeVals: json(r.judge_vals_json, null), homework: r.homework, nextFocus: r.next_focus
  };
}

/** 课后点评：写入 3 要点达成、作业、下节重点，并把大纲课次标为 reviewed */
function saveReview(sessionId, body, user) {
  const r = get('SELECT * FROM sessions WHERE id = ? AND deleted_at IS NULL', [sessionId]);
  if (!r) throw new HttpError(404, 'SESSION_NOT_FOUND', '授课记录不存在');
  const judge = body.judge || r.judge;
  const allowed = ['达标', '部分达标', '未达标'];
  if (!allowed.includes(judge)) throw new HttpError(422, 'VALIDATION_ERROR', 'judge 只能是 达标 / 部分达标 / 未达标');
  const ts = TS();
  const judgeVals = body.judgeVals && typeof body.judgeVals === 'object' ? body.judgeVals : json(r.judge_vals_json, null);
  transaction(() => {
    run(`UPDATE sessions SET judge = ?, judge_vals_json = ?, homework = ?, next_focus = ?, note = COALESCE(?, note),
         review_status = 'done', reviewed_at = ?, attend = COALESCE(?, attend), rpe = COALESCE(?, rpe), updated_at = ?
         WHERE id = ?`,
    [judge, judgeVals ? JSON.stringify(judgeVals) : null, body.homework || null, body.nextFocus || null,
      body.note || null, ts, body.attend || null, body.rpe == null ? null : Number(body.rpe), ts, sessionId]);
    if (r.outline_lesson_id) {
      run(`UPDATE outline_lessons SET status = 'reviewed', note = COALESCE(?, note), updated_at = ? WHERE id = ?`,
        [body.nextFocus || null, ts, r.outline_lesson_id]);
    }
  });
  // 未达标时把下节课一起推进：大纲里追加一节 R 补强（自适应节奏）
  let adjust = null;
  if (r.enrollment_id && judge !== '达标') {
    adjust = advanceAfterReview(r.enrollment_id, r.outline_lesson_id, judge);
  }
  const saved = get('SELECT * FROM sessions WHERE id = ?', [sessionId]);
  return { session: mapSession(saved), adjust };
}

/**
 * 点评后的大纲调整：
 *   - 达标：不动
 *   - 部分达标 / 未达标 + 自适应节奏：把下一个 planned 课次改成同单元 R 补强（不新增课时）
 *   - 固定节奏：不动，只在大纲 note 上记录
 */
function advanceAfterReview(enrollmentId, outlineLessonId, judge) {
  const enroll = get('SELECT * FROM enrollments WHERE id = ?', [enrollmentId]);
  if (!enroll) return null;
  const cur = get('SELECT * FROM outline_lessons WHERE id = ?', [outlineLessonId]);
  if (!cur) return null;
  if (enroll.pace_mode === 'fixed') {
    return { action: 'hold', text: '固定节奏：不插入补强课；下一节沿用本单元动作，把未达标判据放在 ③ 分解练习前 5 分钟复习。' };
  }
  const next = get(`SELECT * FROM outline_lessons WHERE enrollment_id = ? AND seq > ? AND status = 'planned' ORDER BY seq ASC LIMIT 1`,
    [enrollmentId, cur.seq]);
  if (!next) {
    return { action: 'none', text: '本课程包已没有待上课次；建议续包时把本节未达标判据作为第 1 节复查。' };
  }
  // 已经是同单元补强课就不重复改
  if (next.unit_no === cur.unit_no && next.lesson_type === 'R') {
    return { action: 'keep', text: `第 ${next.seq} 节已安排为第 ${cur.unit_no} 单元补强课，按原计划继续。`, outlineLesson: mapOutline(next) };
  }
  run(`UPDATE outline_lessons SET unit_no = ?, lesson_no = ?, lesson_type = 'R', focus = ?, note = ?, updated_at = ? WHERE id = ?`,
    [cur.unit_no, cur.lesson_no, '同单元补强：只练上一节未达标的判据', `由第 ${cur.seq} 节点评自动调整（${judge}）`, TS(), next.id]);
  const after = get('SELECT * FROM outline_lessons WHERE id = ?', [next.id]);
  return {
    action: 'insert_r',
    text: `已把第 ${next.seq} 节改为第 ${cur.unit_no} 单元补强课（R），不新增课时、不改单次时长；后续课次顺延。`,
    outlineLesson: mapOutline(after)
  };
}

/** 今日视图：按日期汇总当天要上的课与待点评记录 */
function today(dateStr) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || '')) ? dateStr : new Date().toISOString().slice(0, 10);
  const lessons = all(`SELECT o.*, e.student_id, s.name AS student_name, s.age_group, s.injury_note, e.pace_mode
                       FROM outline_lessons o
                       JOIN enrollments e ON e.id = o.enrollment_id
                       JOIN students s ON s.id = e.student_id
                       WHERE o.planned_date = ? AND o.status = 'planned' AND e.status = 'active'
                       ORDER BY o.seq ASC`, [date]).map(r => Object.assign(mapOutline(r), {
    studentId: r.student_id, studentName: r.student_name, ageGroup: r.age_group,
    injury: r.injury_note, paceMode: r.pace_mode
  }));
  const unreviewed = all(`SELECT r.*, s.name AS student_name FROM sessions r
                          LEFT JOIN students s ON s.id = r.student_id
                          WHERE r.deleted_at IS NULL AND (r.review_status IS NULL OR r.review_status = 'pending')
                            AND r.lesson_date <= ? ORDER BY r.lesson_date DESC LIMIT 50`, [date])
    .map(r => Object.assign(mapSession(r), { studentName: r.student_name }));
  const overdue = all(`SELECT o.*, s.name AS student_name FROM outline_lessons o
                       JOIN enrollments e ON e.id = o.enrollment_id
                       JOIN students s ON s.id = e.student_id
                       WHERE o.status = 'planned' AND o.planned_date < ? AND e.status = 'active'
                       ORDER BY o.planned_date ASC LIMIT 50`, [date])
    .map(r => Object.assign(mapOutline(r), { studentName: r.student_name }));
  return { date, lessons, unreviewed, overdue, counts: { lessons: lessons.length, unreviewed: unreviewed.length, overdue: overdue.length } };
}

/** 难度表（前端渲染「这节课为什么需要几课」） */
function difficulty() {
  const d = loadDifficulty();
  return d;
}

module.exports = {
  createEnrollment, getEnrollment, listEnrollments, updateEnrollment,
  startLesson, saveReview, advanceAfterReview, today, difficulty,
  mapSession, mapOutline, mapEnrollment, loadDifficulty
};
