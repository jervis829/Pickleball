'use strict';
const { ok, created, noContent } = require('../utils/response');
const auth = require('../services/auth');
const catalog = require('../services/catalog');
const stateSvc = require('../services/state');
const insights = require('../services/insights');
const { curriculum } = require('../repositories/misc');
const skillScoring = require('../services/skill-scoring');
const assessmentProtocols = require('../services/assessment-protocols');
const assessmentRemediation = require('../services/assessment-remediation');
const fitness = require('../services/fitness-assessment');
const outline = require('../services/course-outline');

function crud(entity) {
  return {
    list: ctx => ok(ctx.res, catalog.list(entity, ctx.query)),
    get: ctx => ok(ctx.res, catalog.get(entity, ctx.params.id)),
    create: ctx => created(ctx.res, catalog.create(entity, ctx.body)),
    update: ctx => ok(ctx.res, catalog.update(entity, ctx.params.id, ctx.body)),
    remove: ctx => { catalog.remove(entity, ctx.params.id); noContent(ctx.res); }
  };
}

const students = crud('students');
const plans = crud('plans');
const sessions = crud('sessions');
const assessments = crud('assessments');

module.exports = {
  health: ctx => ok(ctx.res, { status: 'ok', service: 'pickleball-academy', time: new Date().toISOString() }),
  login: ctx => ok(ctx.res, auth.login(ctx.body)),
  me: ctx => ok(ctx.res, auth.me(ctx)),
  refresh: ctx => ok(ctx.res, auth.refresh(ctx)),
  changePassword: ctx => ok(ctx.res, auth.changePassword(ctx, ctx.body)),
  logout: ctx => noContent(ctx.res),
  stateGet: ctx => ok(ctx.res, stateSvc.get()),
  statePut: ctx => ok(ctx.res, stateSvc.put(ctx.body), 200, 'State synced'),
  exportAll: ctx => ok(ctx.res, stateSvc.exportAll()),
  importAll: ctx => ok(ctx.res, stateSvc.importAll(ctx.body), 200, 'Imported'),
  stats: ctx => ok(ctx.res, insights.overview()),
  studentRecords: ctx => ok(ctx.res, insights.studentRecords(ctx.params.id)),
  curriculum: ctx => ok(ctx.res, { units: curriculum.list(), lesson_count: curriculum.list().length * 2 }),
  lessonSkillPoints: ctx => ok(ctx.res, { items: skillScoring.lessonSkillPoints(ctx.params.lesson) }),
  planSkillPoints: ctx => ok(ctx.res, { items: skillScoring.planSkillPoints(ctx.params.id) }),
  sessionSkillScores: ctx => ok(ctx.res, skillScoring.sessionScores(ctx.params.id)),
  saveSessionSkillScores: ctx => ok(ctx.res, skillScoring.saveSessionScores(ctx.params.id, ctx.body.scores, ctx.user)),
  studentSkillProgress: ctx => ok(ctx.res, skillScoring.studentProgress(ctx.params.id)),
  studentTrainingRecommendations: ctx => ok(ctx.res, skillScoring.trainingRecommendations(ctx.params.id, ctx.query.lesson)),
  assessmentProtocols: ctx => ok(ctx.res, assessmentProtocols.listProtocols(ctx.query)),
  assessmentProtocol: ctx => ok(ctx.res, assessmentProtocols.getProtocol(ctx.params.id)),
  createAssessmentAttempt: ctx => created(ctx.res, assessmentProtocols.createAttempt(ctx.body, ctx.user)),
  getAssessmentAttempt: ctx => ok(ctx.res, assessmentProtocols.getAttempt(ctx.params.id)),
  saveAssessmentResults: ctx => ok(ctx.res, assessmentProtocols.saveResults(ctx.params.id, ctx.body.results)),
  studentAssessmentAttempts: ctx => ok(ctx.res, assessmentProtocols.listStudentAttempts(ctx.params.id)),
  reviewAssessmentResult: ctx => ok(ctx.res, assessmentRemediation.reviewResult(ctx.params.id, ctx.params.code, ctx.body, ctx.user)),
  assessmentRemediationPreview: ctx => ok(ctx.res, assessmentRemediation.remediationPreview(ctx.params.id)),
  createAssessmentRemediationPlan: ctx => created(ctx.res, assessmentRemediation.createPlan(ctx.params.id, ctx.body, ctx.user)),
  getAssessmentRemediationPlan: ctx => ok(ctx.res, assessmentRemediation.getPlan(ctx.params.id)),
  confirmAssessmentRemediationPlan: ctx => ok(ctx.res, assessmentRemediation.confirmPlan(ctx.params.id, ctx.user)),
  createScopedAssessmentRetest: ctx => created(ctx.res, assessmentRemediation.createScopedRetest(ctx.body, ctx.user)),
  fitnessBattery: ctx => ok(ctx.res, fitness.battery()),
  createFitnessAssessment: ctx => created(ctx.res, fitness.createAssessment(ctx.body, ctx.user)),
  getFitnessAssessment: ctx => ok(ctx.res, fitness.getAssessment(ctx.params.id)),
  saveFitnessResults: ctx => ok(ctx.res, fitness.saveResults(ctx.params.id, ctx.body.results, ctx.user)),
  finalizeFitnessAssessment: ctx => ok(ctx.res, fitness.finalizeAssessment(ctx.params.id, ctx.body, ctx.user)),
  studentFitnessAssessments: ctx => ok(ctx.res, fitness.listStudentAssessments(ctx.params.id)),
  applyFitnessToStudent: ctx => ok(ctx.res, fitness.applyToStudentProfile(ctx.params.id, ctx.body, ctx.user)),
  studentFitnessLatest: ctx => ok(ctx.res, { assessment: fitness.latestCompleted(ctx.params.id) }),
  /* ---------- P7 课程包 / 大纲 / 今日课 / 课后点评 ---------- */
  curriculumDifficulty: ctx => ok(ctx.res, outline.difficulty()),
  createEnrollment: ctx => created(ctx.res, outline.createEnrollment(ctx.body, ctx.user)),
  listEnrollments: ctx => ok(ctx.res, { items: outline.listEnrollments(ctx.query) }),
  getEnrollment: ctx => ok(ctx.res, outline.getEnrollment(ctx.params.id)),
  updateEnrollment: ctx => ok(ctx.res, outline.updateEnrollment(ctx.params.id, ctx.body)),
  startLesson: ctx => created(ctx.res, outline.startLesson(ctx.params.id, ctx.body || {}, ctx.user)),
  saveSessionReview: ctx => ok(ctx.res, outline.saveReview(ctx.params.id, ctx.body || {}, ctx.user)),
  todayBoard: ctx => ok(ctx.res, outline.today(ctx.query.date)),
  students, plans, sessions, assessments
};
