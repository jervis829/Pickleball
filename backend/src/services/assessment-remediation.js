'use strict';
const { all, get, run, transaction } = require('../db/connection');
const { newId } = require('../utils/crypto');
const { HttpError } = require('../utils/response');
const protocols = require('./assessment-protocols');
const TS = () => new Date().toISOString();
const parse = (v, fallback=[]) => { try { return v ? JSON.parse(v) : fallback; } catch (_) { return fallback; } };

function getAttemptRaw(id) {
  const row = get('SELECT * FROM assessment_attempts WHERE id=?',[id]);
  if (!row) throw new HttpError(404,'NOT_FOUND','评估记录不存在');
  return row;
}
function reviewResult(attemptId, criterionCode, input, user) {
  const a=getAttemptRaw(attemptId);
  if (a.status==='cancelled' || a.status==='submitted') throw new HttpError(409,'ATTEMPT_LOCKED','已提交或取消的评估不可复核');
  const status=String(input.status||'');
  if (!['confirmed','needs_remediation','not_applicable'].includes(status)) throw new HttpError(422,'INVALID_REVIEW_STATUS','复核状态必须为confirmed、needs_remediation或not_applicable');
  const result=get('SELECT id FROM assessment_criterion_results WHERE attempt_id=? AND criterion_code=?',[attemptId,criterionCode]);
  if (!result) throw new HttpError(404,'RESULT_NOT_FOUND','该能力项尚无评估记录，不能复核');
  run('UPDATE assessment_criterion_results SET coach_review_status=?,coach_decision_note=?,updated_at=? WHERE id=?',
    [status,String(input.note||'').slice(0,2000),TS(),result.id]);
  return protocols.getAttempt(attemptId);
}
function findCurriculumMatches(criterion) {
  const words=String([criterion.code,criterion.name,criterion.testProtocol?.task,criterion.testProtocol?.purpose].join(' '))
    .toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g,' ').split(/\s+/).filter(x=>x.length>1);
  const rows=all(`SELECT l.lesson_no AS lessonNo,l.skill_key AS skillKey,l.focus,d.name AS skillName,l.criterion
    FROM lesson_skill_points l JOIN skill_definitions d ON d.skill_key=l.skill_key
    WHERE d.deleted_at IS NULL ORDER BY l.lesson_no,l.sort_order`);
  const scored=rows.map(row=>{
    const hay=String([row.skillName,row.focus,row.criterion].join(' ')).toLowerCase();
    const hits=words.filter(w=>hay.includes(w)).length;
    return {...row,hits};
  }).filter(x=>x.hits>0).sort((a,b)=>b.hits-a.hits||a.lessonNo-b.lessonNo);
  const best=scored[0]?.hits||0;
  if (!best) return [];
  return scored.filter(x=>x.hits===best).slice(0,8);
}
function remediationPreview(attemptId) {
  const attempt=protocols.getAttempt(attemptId);
  const raw=getAttemptRaw(attemptId);
  const items=attempt.results.map(r=>{
    const c=r.criterionSnapshot||{};
    const status=r.coachReviewStatus||'pending';
    const matches=findCurriculumMatches(c);
    return {criterionCode:r.criterionCode,name:c.name||r.criterionCode,score:r.score,
      achieved:r.achieved,coachReviewStatus:status,coachDecisionNote:r.coachDecisionNote||'',
      priority:c.dimension==='rules_safety'?1:(c.gate?2:3),
      lessons:[...new Set(matches.map(x=>x.lessonNo))],
      skillPoints:matches.map(x=>({lessonNo:x.lessonNo,skillKey:x.skillKey,skillName:x.skillName,focus:x.focus,criterion:x.criterion})),
      activity:matches.length?'优先复用匹配课次的原有技术点与练习；先做低速/可控条件，再逐步恢复标准情境':'未找到可靠的48课次映射，需教练手动指定课次与练习',
      needsCoachMapping:matches.length===0
    };
  });
  const missing=(attempt.protocolSnapshot?.criteria||[]).filter(c=>c.required&&!attempt.results.some(r=>r.criterionCode===c.code));
  const needs=items.filter(x=>x.coachReviewStatus==='needs_remediation');
  const pending=items.filter(x=>x.coachReviewStatus==='pending');
  const notApplicable=items.filter(x=>x.coachReviewStatus==='not_applicable');
  const confirmed=items.filter(x=>x.coachReviewStatus==='confirmed');
  return {attemptId,studentId:attempt.studentId,protocolId:attempt.protocolId,protocolStatus:attempt.protocolSnapshot?.status,
    conclusion:attempt.conclusion,items,needsRemediation:needs,pendingReview:pending,confirmed,notApplicable,
    unassessedRequired:missing.map(c=>({criterionCode:c.code,name:c.name})),
    canCreatePlan:needs.length>0&&pending.length===0&&missing.length===0&&attempt.status!=='cancelled',
    policy:'仅根据教练明确标记needs_remediation的能力项生成补训草案；缺测与待复核项不推断为失败。0–4阶段评估不与课堂0–5评分换算。草案需教练确认，不自动改变阶段或晋级。'};
}
function createPlan(attemptId,input,user) {
  const preview=remediationPreview(attemptId);
  if (!preview.canCreatePlan) throw new HttpError(409,'REVIEW_INCOMPLETE','需先补齐必测项并完成教练复核，且至少有一项标记为needs_remediation');
  const attempt=protocols.getAttempt(attemptId);
  const id=String(input.id||newId('ARP')), now=TS();
  transaction(()=>{
    run(`INSERT INTO assessment_remediation_plans
      (id,source_attempt_id,student_id,status,coach_note,created_at,updated_at)
      VALUES (?,?,?,'draft',?,?,?)`,[id,attemptId,attempt.studentId,String(input.coachNote||'').slice(0,2000),now,now]);
    for(const item of preview.needsRemediation) {
      run(`INSERT INTO assessment_remediation_items
        (id,plan_id,criterion_code,criterion_snapshot_json,priority,lesson_numbers_json,skill_keys_json,activity,dose_note,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?)`,
        [newId('ARI'),id,item.criterionCode,JSON.stringify(item),item.priority,JSON.stringify(item.lessons),
         JSON.stringify(item.skillPoints.map(x=>x.skillKey)),item.activity,
         '先嵌入对应课次既有练习时段；剂量由教练根据年龄、疲劳和安全情况确定，不自动加量',now,now]);
    }
  });
  return getPlan(id);
}
function getPlan(id) {
  const p=get('SELECT * FROM assessment_remediation_plans WHERE id=?',[id]);
  if(!p) throw new HttpError(404,'NOT_FOUND','补训计划不存在');
  const items=all('SELECT * FROM assessment_remediation_items WHERE plan_id=? ORDER BY priority,created_at',[id]).map(x=>({
    id:x.id,criterionCode:x.criterion_code,criterion:parse(x.criterion_snapshot_json,{}),priority:x.priority,
    lessonNumbers:parse(x.lesson_numbers_json),skillKeys:parse(x.skill_keys_json),
    activity:x.activity,doseNote:x.dose_note,status:x.status,coachNote:x.coach_note
  }));
  return {id:p.id,sourceAttemptId:p.source_attempt_id,studentId:p.student_id,status:p.status,
    coachNote:p.coach_note,confirmedBy:p.confirmed_by,confirmedAt:p.confirmed_at,items};
}
function confirmPlan(id,user) {
  const p=get('SELECT * FROM assessment_remediation_plans WHERE id=?',[id]);
  if(!p) throw new HttpError(404,'NOT_FOUND','补训计划不存在');
  if(p.status!=='draft') throw new HttpError(409,'PLAN_NOT_DRAFT','只有草案可以确认');
  run("UPDATE assessment_remediation_plans SET status='confirmed',confirmed_by=?,confirmed_at=?,updated_at=? WHERE id=?",
    [user?.username||user?.sub||null,TS(),TS(),id]);
  return getPlan(id);
}
function createScopedRetest(input,user) {
  const parent=getAttemptRaw(String(input.retestOfId||''));
  if(parent.student_id!==String(input.studentId||'')||parent.protocol_id!==String(input.protocolId||'')) {
    throw new HttpError(422,'INVALID_RETEST_LINK','复测必须关联同一学员、同一协议版本');
  }
  const plan=input.remediationPlanId?get('SELECT * FROM assessment_remediation_plans WHERE id=?',[input.remediationPlanId]):null;
  if(input.remediationPlanId&&(!plan||plan.source_attempt_id!==parent.id||plan.status==='draft'||plan.status==='cancelled')) {
    throw new HttpError(409,'REMEDIATION_PLAN_NOT_CONFIRMED','复测需关联已确认的补训计划');
  }
  let codes=input.criterionCodes;
  if(!Array.isArray(codes)||!codes.length||codes.some(x=>typeof x!=='string')) throw new HttpError(422,'INVALID_RETEST_SCOPE','复测必须明确指定至少一个criterionCode');
  const parentAttempt=protocols.getAttempt(parent.id);
  const eligible=new Set((parentAttempt.results||[]).filter(r=>r.coachReviewStatus==='needs_remediation').map(r=>r.criterionCode));
  if(codes.some(x=>!eligible.has(x))) throw new HttpError(422,'INVALID_RETEST_SCOPE','只能复测原评估中由教练确认需补训的能力项');
  const created=protocols.createAttempt({...input,retestOfId:parent.id},user);
  run('UPDATE assessment_attempts SET criteria_scope_json=? WHERE id=?',[JSON.stringify([...new Set(codes)]),created.id]);
  return protocols.getAttempt(created.id);
}
module.exports={reviewResult,remediationPreview,createPlan,getPlan,confirmPlan,createScopedRetest};
