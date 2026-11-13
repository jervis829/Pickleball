'use strict';
const entities = require('../repositories/entities');
const { settings } = require('../repositories/misc');
const { HttpError } = require('../utils/response');

const r2 = (n) => n === null ? null : Math.round(n * 100) / 100;

/** 服务端 KPI：每个指标同时给出定义与公式，避免前端展示无法追溯的数字 */
function overview() {
  const students = entities.listAll('students');
  const plans = entities.listAll('plans');
  const sessions = entities.listAll('sessions');
  const assessments = entities.listAll('assessments');
  const defaults = Object.assign({ renewWarn: 3 }, settings.get('defaults', {}));
  const thresholds = settings.get('thresholds', {});

  const inTraining = students.filter(s => s.status === '在训').length;
  const attended = sessions.filter(s => s.attend === '出勤').length;
  const attendanceRate = sessions.length ? attended / sessions.length : null;
  const pendingExam = students.filter(s => {
    const examLesson = Number(s.stage) === 1 ? 16 : Number(s.stage) === 2 ? 32 : 48;
    return s.status === '待考' || (Number(s.used) >= examLesson - 2 && !assessments.some(a => a.studentId === s.id && Number(a.stage) === Number(s.stage)));
  }).length;
  const warnLine = Number(defaults.renewWarn) || 3;
  const renewWarnings = students.filter(s => s.total != null && s.used != null && (Number(s.total) - Number(s.used)) <= warnLine).length;
  const calibrated = ['t1', 't2', 't3', 'line2', 'line3', 'w'].every(k => thresholds[k] !== undefined && thresholds[k] !== '');
  const recentPlans = plans.filter(p => {
    const t = new Date(p.date || p.created_at);
    return !isNaN(t) && (Date.now() - t.getTime()) <= 7 * 86400000 && (Date.now() - t.getTime()) >= 0;
  }).length;

  return {
    values: {
      students_total: students.length,
      in_training: inTraining,
      plans_total: plans.length,
      plans_last_7d: recentPlans,
      sessions_total: sessions.length,
      attendance_rate: r2(attendanceRate),
      pending_exam: pendingExam,
      renew_warnings: renewWarnings,
      assessments_total: assessments.length,
      thresholds_calibrated: calibrated
    },
    definitions: [
      { key: 'students_total', label: '在册学员', formula: 'COUNT(students WHERE deleted_at IS NULL)' },
      { key: 'in_training', label: '在训学员', formula: 'COUNT(students WHERE status = 在训)' },
      { key: 'plans_total', label: '教案总数', formula: 'COUNT(plans WHERE deleted_at IS NULL)' },
      { key: 'plans_last_7d', label: '近 7 日计划数', formula: 'COUNT(plans WHERE date >= 今日 - 7 天)' },
      { key: 'sessions_total', label: '授课记录数', formula: 'COUNT(sessions WHERE deleted_at IS NULL)' },
      { key: 'attendance_rate', label: '出勤率', formula: '出勤记录数 ÷ 授课记录数 × 100%（无记录时为 null）' },
      { key: 'pending_exam', label: '待考人数', formula: 'status = 待考 或 已耗课次 ≥ 阶段考核课次 - 2 且本阶段无考核记录' },
      { key: 'renew_warnings', label: '续费预警人数', formula: '剩余课次 (total - used) ≤ 预警课次 [' + warnLine + ']' },
      { key: 'assessments_total', label: '考核记录数', formula: 'COUNT(assessments WHERE deleted_at IS NULL)' },
      { key: 'thresholds_calibrated', label: '阈值已校准', formula: 't1/t2/t3/line2/line3/w 六项全部有值' }
    ],
    caveats: [
      '阈值未校准时，晋级判定一律显示「无法判定」，不给出晋级结论。',
      '本接口不做医疗或商业预测，不承诺晋级率、转化率与伤病恢复效果。'
    ]
  };
}

/** 学员学习记录：档案入口点进去看到的全部内容 */
function studentRecords(id) {
  const student = entities.find('students', id);
  const plans = entities.listAll('plans').filter(p => (p.studentIds || []).includes(id));
  const sessions = entities.listAll('sessions').filter(s => s.studentId === id);
  const assessments = entities.listAll('assessments').filter(a => a.studentId === id);
  const attended = sessions.filter(s => s.attend === '出勤').length;
  const timeline = [
    ...plans.map(p => ({ type: 'plan', date: p.date || p.created_at, lesson: p.lesson, title: '第 ' + p.lesson + ' 课教案 · ' + (p.tech || ''), detail: p.ageName || '' })),
    ...sessions.map(s => ({ type: 'session', date: s.date || s.created_at, lesson: s.lesson, title: '第 ' + (s.lesson || '—') + ' 课授课记录 · ' + (s.attend || ''), detail: [s.judge, s.rpe != null ? 'RPE ' + s.rpe : '', s.note].filter(Boolean).join(' / ') })),
    ...assessments.map(a => ({ type: 'assessment', date: a.date || a.created_at, lesson: null, title: '阶段 ' + a.stage + ' 考核 · ' + (a.conclusion || ''), detail: a.total != null ? '总分 ' + a.total : '' }))
  ].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));

  return {
    student,
    progress: {
      used: student.used, total: student.total, stage: student.stage,
      attendance_rate: sessions.length ? r2(attended / sessions.length) : null,
      session_count: sessions.length, plan_count: plans.length, assessment_count: assessments.length
    },
    safety: {
      injury_note: student.injury || '',
      needs_assessment: Boolean(student.injury) || ['youth', 'senior'].includes(student.age)
    },
    plans, sessions, assessments, timeline
  };
}

module.exports = { overview, studentRecords };
