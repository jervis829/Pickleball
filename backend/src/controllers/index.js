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
const v3Curriculum = require('../services/v3-curriculum');
const v3Fitness = require('../services/v3-fitness');
const v3StudentReports = require('../services/v3-student-reports');
const v3Plans = require('../services/v3-plans');

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
  /* ---------- V3.0 配置驱动课程大纲 + 6维零道具体能 + 历史快照 + 教学计划 ---------- */
  v3GetCurriculumConfig: ctx => ok(ctx.res, v3Curriculum.getConfig()),
  v3SaveCurriculumConfig: ctx => ok(ctx.res, v3Curriculum.saveConfig(ctx.body)),
  v3ResetCurriculumConfig: ctx => ok(ctx.res, v3Curriculum.resetConfig()),
  v3GetFitnessBattery: ctx => ok(ctx.res, v3Fitness.getBattery()),
  v3ListStudents: ctx => ok(ctx.res, { items: v3StudentReports.listStudentsOverview() }),
  v3CreateStudent: ctx => created(ctx.res, v3StudentReports.createStudentWithBaseline(ctx.body || {})),
  v3GetStudentReport: ctx => ok(ctx.res, v3StudentReports.getStudentFullReport(ctx.params.id)),
  v3UpdateStudent: ctx => ok(ctx.res, v3StudentReports.updateStudentProfile(ctx.params.id, ctx.body || {})),
  v3DeleteStudent: ctx => { catalog.remove('students', ctx.params.id); noContent(ctx.res); },
  v3UpdateStudentScores: ctx => ok(ctx.res, v3StudentReports.updateStudentScores(ctx.params.id, (ctx.body && ctx.body.scores) || ctx.body || {}, ctx.body || {})),
  v3ListSnapshots: ctx => ok(ctx.res, { items: v3StudentReports.listSnapshots(ctx.params.id) }),
  v3CaptureSnapshot: ctx => created(ctx.res, v3StudentReports.captureSnapshot(ctx.params.id, ctx.body || {})),
  v3CompareSnapshots: ctx => ok(ctx.res, v3StudentReports.compareSnapshots(ctx.params.id, ctx.query.currentId, ctx.query.prevId)),
  v3SaveFitnessReport: ctx => created(ctx.res, v3Fitness.saveFitnessReport(v3StudentReports.requireStudent(ctx.params.id), ctx.body || {})),
  v3ListFitnessReports: ctx => { v3StudentReports.requireStudent(ctx.params.id); return ok(ctx.res, { items: v3Fitness.listFitnessHistory(ctx.params.id) }); },
  v3ListPlans: ctx => ok(ctx.res, { items: v3Plans.listPlans() }),
  v3CreatePlan: ctx => created(ctx.res, v3Plans.createPlan(ctx.body || {})),
  v3GetPlan: ctx => ok(ctx.res, v3Plans.getPlanDetail(ctx.params.id)),
  v3AddPlanStudents: ctx => ok(ctx.res, v3Plans.addStudentsToPlan(ctx.params.id, (ctx.body && ctx.body.studentIds) || [])),
  v3ExtendPlan: ctx => ok(ctx.res, v3Plans.extendPlan(ctx.params.id, ctx.body || {})),
  v3ReorderPlan: ctx => ok(ctx.res, v3Plans.reorderPlanLessons(ctx.params.id, (ctx.body && ctx.body.orderedLessonIds) || [])),
  v3InsertPlanLesson: ctx => created(ctx.res, v3Plans.insertPlanLesson(ctx.params.id, ctx.body || {})),
  v3GetPlanLesson: ctx => ok(ctx.res, v3Plans.getLessonDetail(ctx.params.id, ctx.params.lessonId)),
  v3UpdatePlanLesson: ctx => ok(ctx.res, v3Plans.updatePlanLesson(ctx.params.id, ctx.params.lessonId, ctx.body || {})),
  v3DeletePlanLesson: ctx => ok(ctx.res, v3Plans.deletePlanLesson(ctx.params.id, ctx.params.lessonId)),
  v3CompletePlanLesson: ctx => ok(ctx.res, v3Plans.completePlanLesson(ctx.params.id, ctx.params.lessonId, ctx.body || {})),
  students, plans, sessions, assessments
};
