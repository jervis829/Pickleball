'use strict';
const { all, get } = require('../db/connection');
const { HttpError } = require('../utils/response');
const skillScoring = require('./skill-scoring');

const parse = (v, fallback = {}) => { try { return v ? JSON.parse(v) : fallback; } catch (_) { return fallback; } };
const round = n => n == null ? null : Math.round(n * 100) / 100;

function studentAthleteProfile(studentId) {
  const student = get(`SELECT id,name,age_group AS age,stage,used,total,status,goal,injury_note AS injury,
      tech_score AS techScore,fit_score AS fitScore,created_at AS createdAt
    FROM students WHERE id=? AND deleted_at IS NULL`, [studentId]);
  if (!student) throw new HttpError(404, 'STUDENT_NOT_FOUND', '学员不存在');

  const skill = skillScoring.studentProgress(studentId);
  const sessions = all(`SELECT id,lesson_date AS date,lesson,minutes,attend,judge,rpe,note,plan_id AS planId
    FROM sessions WHERE student_id=? AND deleted_at IS NULL
    ORDER BY lesson_date DESC,created_at DESC`, [studentId]);
  const attempts = all(`SELECT id,protocol_id AS protocolId,protocol_snapshot_json AS protocolSnapshot,
      assessment_date AS date,status,conclusion,retest_of_id AS retestOfId,lesson_number AS lessonNumber
    FROM assessment_attempts WHERE student_id=? ORDER BY assessment_date DESC,created_at DESC`, [studentId]).map(a => {
      const protocol = parse(a.protocolSnapshot);
      const results = all(`SELECT criterion_code AS code,criterion_snapshot_json AS criterionSnapshot,
          score,achieved,coach_review_status AS reviewStatus,coach_decision_note AS reviewNote,
          observations,evidence_ref AS evidenceRef,raw_trials_json AS rawTrials
        FROM assessment_criterion_results WHERE attempt_id=? ORDER BY criterion_code`, [a.id]).map(r => ({
          code:r.code, criterion:parse(r.criterionSnapshot), score:r.score,
          achieved:r.achieved==null?null:Boolean(r.achieved), reviewStatus:r.reviewStatus||'pending',
          reviewNote:r.reviewNote||'', observations:r.observations||'', evidenceRef:r.evidenceRef||'',
          rawTrials:parse(r.rawTrials,[])
        }));
      return {id:a.id,protocolId:a.protocolId,stage:protocol.stage||null,protocolName:protocol.name||'阶段评估',
        protocolVersion:protocol.version||null,protocolStatus:protocol.status||'unknown',date:a.date,
        lessonNumber:a.lessonNumber,status:a.status,conclusion:a.conclusion,retestOfId:a.retestOfId,
        results,requiredCount:(protocol.criteria||[]).filter(c=>c.required).length,
        reviewedCount:results.filter(r=>r.reviewStatus!=='pending').length,
        missingRequired:(protocol.criteria||[]).filter(c=>c.required&&!results.some(r=>r.code===c.code)).map(c=>c.code)};
    });
  const plans = all(`SELECT id,source_attempt_id AS sourceAttemptId,status,coach_note AS coachNote,
      confirmed_at AS confirmedAt,created_at AS createdAt,updated_at AS updatedAt
    FROM assessment_remediation_plans WHERE student_id=? ORDER BY created_at DESC`, [studentId]).map(p => ({
      ...p,items:all(`SELECT criterion_code AS criterionCode,priority,lesson_numbers_json AS lessons,
          skill_keys_json AS skillKeys,activity,dose_note AS doseNote,status,coach_note AS coachNote
        FROM assessment_remediation_items WHERE plan_id=? ORDER BY priority,created_at`, [p.id]).map(i=>({
          ...i,lessons:parse(i.lessons,[]),skillKeys:parse(i.skillKeys,[])
        }))
    }));
  const attended=sessions.filter(s=>s.attend==='出勤').length;
  const scoreValues=skill.skills.map(s=>s.latestScore);
  const attemptStageById=new Map(attempts.map(a=>[a.id,a.stage]));
  const stageSummary=[1,2,3].map(stage=>{
    const list=attempts.filter(a=>a.stage===stage);
    const latest=list[0]||null;
    return {stage,attemptCount:list.length,latestAttemptId:latest?.id||null,
      latestDate:latest?.date||null,protocolStatus:latest?.protocolStatus||null,
      reviewed:latest?latest.reviewedCount:0,required:latest?latest.requiredCount:0,
      missingRequired:latest?latest.missingRequired:[],pendingReview:latest?latest.results.filter(r=>r.reviewStatus==='pending').length:0,
      remediationCount:plans.filter(p=>attemptStageById.get(p.sourceAttemptId)===stage&&p.items.some(i=>i.status!=='completed')).length};
  });
  const timeline=[
    ...sessions.map(s=>({type:'session',date:s.date,title:'第'+(s.lesson||'—')+'课授课',detail:[s.attend,s.judge,s.rpe!=null?'RPE '+s.rpe:null,s.note].filter(Boolean).join(' · '),ref:s.id})),
    ...attempts.map(a=>({type:a.retestOfId?'retest':'assessment',date:a.date,title:(a.retestOfId?'阶段复测':'阶段评估')+' · '+(a.protocolName||'能力检查'),
      detail:a.results.length+'项有记录 / '+a.reviewedCount+'项已复核',ref:a.id})),
    ...plans.map(p=>({type:'remediation',date:p.createdAt,title:'补训计划 · '+p.status,
      detail:p.items.length+'项能力 · '+p.items.map(i=>i.criterionCode).join('、'),ref:p.id}))
  ].sort((a,b)=>String(b.date||'').localeCompare(String(a.date||'')));
  const evidence={sessionCount:sessions.length,attendedCount:attended,attendanceRate:sessions.length?round(attended/sessions.length):null,
    scoredSkillPoints:skill.totalScores,distinctSkills:skill.skills.length,
    assessmentAttempts:attempts.length,assessmentResults:attempts.reduce((n,a)=>n+a.results.length,0),
    reviewedResults:attempts.reduce((n,a)=>n+a.reviewedCount,0),
    resultsWithObservation:attempts.reduce((n,a)=>n+a.results.filter(r=>r.observations||r.evidenceRef||r.rawTrials.length).length,0),
    remediationPlans:plans.length};
  return {
    student,generatedAt:new Date().toISOString(),
    overview:{stage:student.stage,lessonProgress:{used:Number(student.used)||0,total:Number(student.total)||48},
      skillScoreCount:skill.totalScores,skillCount:skill.skills.length,latestSkillAverage:scoreValues.length?round(scoreValues.reduce((a,b)=>a+b,0)/scoreValues.length):null,
      weakSkills:skill.skills.filter(s=>s.status==='weak').length,masteredSkills:skill.skills.filter(s=>s.status==='mastered').length,
      sessionCount:sessions.length,attendanceRate:evidence.attendanceRate},
    skillDevelopment:skill.skills,
    stageAssessments:attempts,
    stageSummary,
    remediationPlans:plans,
    recentSessions:sessions.slice(0,10),
    evidence,timeline,
    interpretation:{scale:'课堂技术评分0–5；阶段能力评分0–4，独立解释，不进行换算。',
      status:'能力状态仅依据已有评分记录和教练复核；草案协议不产生自动晋级结论。',
      limits:['技术点趋势来自已录入评分，不能代表未观察到的能力。','阶段评估协议可能仍处于草案/试测状态；不同测试条件的数据不宜直接比较。','补训映射需教练核验；本报告不自动决定晋级或医疗适宜性。']}
  };
}
module.exports={studentAthleteProfile};
