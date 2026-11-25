'use strict';
const { get, all, run, transaction } = require('../db/connection');
const { meta } = require('../repositories/misc');
const { HttpError } = require('../utils/response');
const { newId } = require('../utils/crypto');
const v3Curriculum = require('./v3-curriculum');
const v3Fitness = require('./v3-fitness');
const v3StudentReports = require('./v3-student-reports');

const TS = () => new Date().toISOString();

function requirePlan(planId) {
  const row = get('SELECT * FROM training_plans WHERE id = ? AND deleted_at IS NULL', [planId]);
  if (!row) throw new HttpError(404, 'PLAN_NOT_FOUND', `找不到教学计划: ${planId}`);
  return row;
}

function requirePlanLesson(planId, lessonId) {
  const row = get('SELECT * FROM training_plan_lessons WHERE id = ? AND plan_id = ?', [lessonId, planId]);
  if (!row) throw new HttpError(404, 'LESSON_NOT_FOUND', `找不到计划课次: ${lessonId}`);
  return row;
}

function getModuleByCode(cfg, code) {
  return (cfg.modules || []).find(m => m.code === code) || null;
}

function scaleMinutes(baseMins, targetTotal) {
  const ratio = (Number(targetTotal) || 60) / 60;
  return Math.max(2, Math.round(baseMins * ratio));
}

function buildLessonPlanContent(moduleObj, secondaryObj, minutes, studentsDetail, cfg) {
  const targetMinutes = Number(minutes) || Number(cfg.defaultMinutes) || 60;
  const plan60 = moduleObj.plan60 || {
    goal: moduleObj.title,
    warmup: '关节动态激活 5 分钟 + 原地小碎步垫步 3 分钟',
    microTalk: `${moduleObj.title} 核心动作原理与站位讲解`,
    drills: [{ title: '定点多球分解', ballsPerMin: 16, sets: '3组×12球', note: '先做慢动作定型再提速' }],
    game: '半场限制条件配合练习与情景收官',
    wrapup: '2分钟动作复盘与居家微练布置'
  };

  const s60 = cfg.structure60 || (cfg.dosageModel && cfg.dosageModel.structure60) || [];
  const s90 = cfg.structure90 || (cfg.dosageModel && cfg.dosageModel.structure90) || [];
  const baseStruct = targetMinutes >= 85 && Array.isArray(s90) && s90.length ? s90 : s60;
  const segMinutes = baseStruct.length
    ? baseStruct.map(s => ({
        name: s.name,
        minutes: targetMinutes >= 85 && s90.length ? (s.mins || s.minutes) : scaleMinutes(s.mins || s.minutes, targetMinutes),
        focus: s.focus
      }))
    : [
        { name: '针对性热身与步伐激活', minutes: scaleMinutes(8, targetMinutes) },
        { name: '核心精讲与评分标准', minutes: scaleMinutes(7, targetMinutes) },
        { name: '三步持拍分解练球', minutes: scaleMinutes(28, targetMinutes) },
        { name: '限条件实战对抗', minutes: scaleMinutes(13, targetMinutes) },
        { name: '放松总结与居家练习', minutes: scaleMinutes(4, targetMinutes) }
      ];

  const fitnessAdaptations = [];
  const safetyAlerts = [];
  const rpeCaps = [];

  for (const s of studentsDetail) {
    if (s.injury) {
      safetyAlerts.push(`${s.name} 伤病提示：${s.injury}（控制强度与大幅度变向）`);
    }
    const fit = s.latestFitness;
    if (fit) {
      if (fit.rpeCap) rpeCaps.push(fit.rpeCap);
      for (const h of fit.trainingHints || []) {
        fitnessAdaptations.push({
          studentId: s.id,
          studentName: s.name,
          dimKey: h.dimKey,
          dimName: h.dimName,
          score: h.score,
          classroomHint: h.classroomHint,
          homeTip: h.homeTip
        });
      }
      for (const sn of fit.safetyNotes || []) {
        if (sn.includes('温和模式') || sn.includes('跳过')) {
          safetyAlerts.push(`${s.name}：${sn}`);
        }
      }
    }
  }

  const dosageModel = cfg.dosageModel || { baseBalls60: 16, maxBalls60: 32 };
  const baseDose = targetMinutes >= 85 ? Math.round((dosageModel.baseBalls60 || 16) * 1.4) : (dosageModel.baseBalls60 || 16);
  const weakMobility = fitnessAdaptations.some(a => a.dimKey === 'mobility');
  const weakEndurance = fitnessAdaptations.some(a => a.dimKey === 'endurance');
  const recommendedBalls = weakEndurance ? Math.max(12, baseDose - 3) : baseDose;

  const isFirstBasic = moduleObj.code === 'B01';

  return {
    moduleCode: moduleObj.code,
    moduleTitle: moduleObj.title,
    track: moduleObj.track,
    categoryId: moduleObj.categoryId,
    difficulty: moduleObj.difficulty,
    secondaryModule: secondaryObj ? { code: secondaryObj.code, title: secondaryObj.title, kp: secondaryObj.kp || [] } : null,
    totalMinutes: targetMinutes,
    goal: plan60.goal || moduleObj.title,
    kp: moduleObj.kp || [],
    remedialFocus: moduleObj.remedialFocus || '',
    firstLessonMicroTalk: isFirstBasic
      ? '【首课前10分钟微讲】大陆式握拍与手腕锁定 + 标准准备姿势 + 记分/发球/双跳/非截击区4条核心规则（不单开空讲课，直接接正手击球）'
      : null,
    segments: [
      {
        title: segMinutes[0].name,
        minutes: segMinutes[0].minutes,
        content: plan60.warmup,
        fitnessLink: fitnessAdaptations.filter(a => ['power', 'flexibility', 'mobility'].includes(a.dimKey)).map(a => `${a.studentName}(${a.dimName})：${a.classroomHint}`)
      },
      {
        title: segMinutes[1].name,
        minutes: segMinutes[1].minutes,
        content: plan60.microTalk,
        kp: moduleObj.kp || []
      },
      {
        title: segMinutes[2].name,
        minutes: segMinutes[2].minutes,
        drills: (plan60.drills || []).map(d => ({
          ...d,
          adjustedNote: weakMobility ? `${d.note}｜结合移动激活：每2球加入小碎步横移到位再击` : d.note
        })),
        secondaryContent: secondaryObj ? `【双单元合练】后半段加入「${secondaryObj.code} ${secondaryObj.title}」核心要点：${(secondaryObj.kp || []).slice(0, 2).join('；')}` : null,
        recommendedBallsPerSlot: recommendedBalls,
        restTip: weakEndurance ? '短组多歇：每 6–8 球休息 30 秒喝水换气，保证技术动作不变形' : '每组 10–12 球间歇 20 秒复盘手感',
        fitnessLink: fitnessAdaptations.filter(a => ['reaction', 'mobility', 'balance', 'endurance'].includes(a.dimKey)).map(a => `${a.studentName}(${a.dimName})：${a.classroomHint}`)
      },
      {
        title: segMinutes[3].name,
        minutes: segMinutes[3].minutes,
        content: plan60.game
      },
      {
        title: segMinutes[4].name,
        minutes: segMinutes[4].minutes,
        content: plan60.wrapup,
        homePrescriptions: fitnessAdaptations.map(a => `${a.studentName}·${a.dimName}居家加练：${a.homeTip}`)
      }
    ],
    rpeTarget: rpeCaps.length ? Math.min(...rpeCaps) : 7,
    fitnessAdaptations,
    safetyAlerts
  };
}

function getPlanStudentsDetailed(planId) {
  const rows = all(
    `SELECT tps.used_lessons, s.*
     FROM training_plan_students tps
     JOIN students s ON s.id = tps.student_id
     WHERE tps.plan_id = ? AND s.deleted_at IS NULL
     ORDER BY s.created_at ASC`,
    [planId]
  );
  return rows.map(r => ({
    ...v3StudentReports.formatStudent(r),
    usedLessonsInPlan: r.used_lessons || 0,
    latestFitness: v3Fitness.getLatestFitness(r.id)
  }));
}

function getPlanDetail(planId) {
  const plan = requirePlan(planId);
  const cfg = v3Curriculum.getConfig();
  const students = getPlanStudentsDetailed(planId);
  const lessonsRows = all(
    `SELECT * FROM training_plan_lessons WHERE plan_id = ? ORDER BY seq ASC`,
    [planId]
  );
  const reviewRows = all(
    `SELECT * FROM training_lesson_reviews WHERE plan_id = ?`,
    [planId]
  );
  const reviewsByLesson = new Map();
  for (const rv of reviewRows) {
    if (!reviewsByLesson.has(rv.plan_lesson_id)) reviewsByLesson.set(rv.plan_lesson_id, []);
    reviewsByLesson.get(rv.plan_lesson_id).push({
      id: rv.id,
      studentId: rv.student_id,
      attend: rv.attend,
      moduleScores: JSON.parse(rv.module_scores_json || '{}'),
      rpe: rv.rpe,
      homework: rv.homework || '',
      feedback: rv.feedback || '',
      reportSnapshotId: rv.report_snapshot_id || null,
      createdAt: rv.created_at
    });
  }

  const lessons = lessonsRows.map(lr => {
    const snap = JSON.parse(lr.module_snapshot_json || '{}');
    const liveMod = getModuleByCode(cfg, lr.module_code);
    const modMeta = lr.status === 'completed' ? snap : (liveMod || snap);
    return {
      id: lr.id,
      planId: lr.plan_id,
      seq: lr.seq,
      moduleCode: lr.module_code,
      secondaryModuleCode: lr.secondary_module_code || null,
      moduleTitle: modMeta.title || lr.module_code,
      track: modMeta.track || 'basic',
      categoryId: modMeta.categoryId || '',
      plannedDate: lr.planned_date || null,
      minutes: lr.minutes || 60,
      isRemedial: Boolean(lr.is_remedial),
      status: lr.status,
      locked: lr.status === 'completed',
      coachNote: lr.coach_note || '',
      completedAt: lr.completed_at || null,
      reviews: reviewsByLesson.get(lr.id) || []
    };
  });

  return {
    id: plan.id,
    name: plan.name,
    packageType: plan.package_type,
    totalLessons: plan.total_lessons,
    usedLessons: plan.used_lessons,
    defaultMinutes: plan.default_minutes,
    trackMode: plan.track_mode,
    status: plan.status,
    curriculumVersion: plan.curriculum_version,
    note: plan.note || '',
    createdAt: plan.created_at,
    updatedAt: plan.updated_at,
    students,
    lessons
  };
}

function listPlans() {
  const rows = all('SELECT id FROM training_plans WHERE deleted_at IS NULL ORDER BY updated_at DESC, created_at DESC');
  return rows.map(r => getPlanDetail(r.id));
}

function pickInitialCodes(cfg, studentIds, totalLessons, trackMode, bundleId, customCodes) {
  const modules = (cfg.modules || []).slice().sort((a, b) => (a.seq || 0) - (b.seq || 0));
  const basicMods = modules.filter(m => m.track === 'basic');
  const advMods = modules.filter(m => m.track !== 'basic');

  // 计算班级最小分（木桶短板优先照顾未掌握模块）
  const classMinScore = new Map();
  for (const m of modules) classMinScore.set(m.code, 5);
  for (const sid of studentIds) {
    const live = v3StudentReports.getLiveAssessment(sid, cfg);
    for (const m of live.modules) {
      const prev = classMinScore.get(m.code);
      if (m.score < prev) classMinScore.set(m.code, m.score);
    }
  }

  let picked = [];
  if (trackMode === 'custom' && Array.isArray(customCodes) && customCodes.length) {
    picked = customCodes.filter(c => getModuleByCode(cfg, c));
  } else if (trackMode === 'bundle' && bundleId) {
    const b = (cfg.bundles || []).find(x => x.id === bundleId);
    if (b) picked = (b.codes || []).filter(c => getModuleByCode(cfg, c));
  } else if (trackMode === 'advanced_only') {
    const unmasteredAdv = advMods.filter(m => (classMinScore.get(m.code) || 0) < 3).map(m => m.code);
    picked = unmasteredAdv.length ? unmasteredAdv : advMods.map(m => m.code);
  } else {
    // 默认 basic_first：初阶未达标顺排 + 进阶顺延/按需选修
    const unmasteredBasic = basicMods.filter(m => (classMinScore.get(m.code) || 0) < 2).map(m => m.code);
    const orderedBasic = unmasteredBasic.length ? unmasteredBasic : basicMods.map(m => m.code);
    const advRecommended = advMods.filter(m => (classMinScore.get(m.code) || 0) < 3).map(m => m.code);
    picked = [...orderedBasic, ...advRecommended];
  }

  if (!picked.length) picked = modules.map(m => m.code);

  const result = [];
  for (let i = 0; i < totalLessons; i++) {
    const isExtra = i >= picked.length;
    const code = picked[i % picked.length];
    result.push({ code, isRemedial: isExtra });
  }
  return result;
}

function addDays(isoDate, days) {
  if (!isoDate) return null;
  const d = new Date(isoDate + 'T00:00:00Z');
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function createPlan(payload) {
  const cfg = v3Curriculum.getConfig();
  const studentIds = Array.isArray(payload.studentIds) ? [...new Set(payload.studentIds.filter(Boolean))] : [];
  if (!studentIds.length) {
    throw new HttpError(422, 'INVALID_PLAN', '请至少选择 1 名学员创建教学计划');
  }
  for (const sid of studentIds) v3StudentReports.requireStudent(sid);

  const totalLessons = Math.max(1, Math.min(200, Math.round(Number(payload.totalLessons) || 12)));
  const defaultMinutes = Math.max(30, Math.min(180, Math.round(Number(payload.defaultMinutes) || cfg.defaultMinutes || 60)));
  const packageType = payload.packageType || (studentIds.length === 1 ? 'solo' : studentIds.length <= 6 ? 'small' : 'large');
  const trackMode = payload.trackMode || 'basic_first';
  const name = String(payload.name || '').trim() || `${studentIds.length > 1 ? `${studentIds.length}人小班` : '1v1私教'} · ${totalLessons}课时计划`;

  const picked = pickInitialCodes(cfg, studentIds, totalLessons, trackMode, payload.bundleId, payload.customCodes);
  const startDate = payload.startDate ? String(payload.startDate).slice(0, 10) : TS().slice(0, 10);
  const intervalDays = Math.max(1, Math.min(30, Number(payload.intervalDays) || 7));

  const planId = newId('PLN');
  const ts = TS();

  transaction(() => {
    run(
      `INSERT INTO training_plans (id, name, package_type, total_lessons, used_lessons, default_minutes, track_mode, status, curriculum_version, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?, 'active', ?, ?, ?, ?)`,
      [planId, name, packageType, totalLessons, defaultMinutes, trackMode, cfg.version, payload.note ? String(payload.note) : '', ts, ts]
    );

    for (const sid of studentIds) {
      run(`INSERT INTO training_plan_students (plan_id, student_id, used_lessons) VALUES (?, ?, 0)`, [planId, sid]);
    }

    picked.forEach((item, idx) => {
      const mod = getModuleByCode(cfg, item.code) || cfg.modules[0];
      const lId = newId('LES');
      const pDate = addDays(startDate, idx * intervalDays);
      run(
        `INSERT INTO training_plan_lessons
          (id, plan_id, seq, module_code, secondary_module_code, module_snapshot_json, planned_date, minutes, is_remedial, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, 'planned', ?, ?)`,
        [lId, planId, idx + 1, mod.code, JSON.stringify(mod), pDate, defaultMinutes, item.isRemedial ? 1 : 0, ts, ts]
      );
    });
  });

  meta.bump();
  return getPlanDetail(planId);
}

function getLessonDetail(planId, lessonId) {
  requirePlan(planId);
  const row = requirePlanLesson(planId, lessonId);
  const cfg = v3Curriculum.getConfig();
  const students = getPlanStudentsDetailed(planId);

  if (row.status === 'completed' && row.lesson_plan_snapshot_json) {
    return {
      lesson: {
        id: row.id,
        planId: row.plan_id,
        seq: row.seq,
        moduleCode: row.module_code,
        secondaryModuleCode: row.secondary_module_code || null,
        plannedDate: row.planned_date,
        minutes: row.minutes,
        isRemedial: Boolean(row.is_remedial),
        status: row.status,
        locked: true,
        coachNote: row.coach_note || '',
        completedAt: row.completed_at
      },
      planContent: JSON.parse(row.lesson_plan_snapshot_json),
      students
    };
  }

  const snapMod = JSON.parse(row.module_snapshot_json || '{}');
  const liveMod = getModuleByCode(cfg, row.module_code) || snapMod;
  const secMod = row.secondary_module_code ? getModuleByCode(cfg, row.secondary_module_code) : null;
  const studentsWithScores = students.map(s => {
    const live = v3StudentReports.getLiveAssessment(s.id, cfg);
    const modRec = live.modules.find(m => m.code === liveMod.code);
    return {
      ...s,
      currentModuleScore: modRec ? modRec.score : 0,
      practiceCount: modRec ? modRec.practiceCount : 0
    };
  });

  const planContent = buildLessonPlanContent(liveMod, secMod, row.minutes, studentsWithScores, cfg);
  return {
    lesson: {
      id: row.id,
      planId: row.plan_id,
      seq: row.seq,
      moduleCode: liveMod.code,
      secondaryModuleCode: secMod ? secMod.code : null,
      plannedDate: row.planned_date,
      minutes: row.minutes,
      isRemedial: Boolean(row.is_remedial),
      status: row.status,
      locked: false,
      coachNote: row.coach_note || '',
      completedAt: null
    },
    planContent,
    students: studentsWithScores
  };
}

function resequencePlanLessons(planId) {
  const rows = all('SELECT id, status FROM training_plan_lessons WHERE plan_id = ? ORDER BY seq ASC, created_at ASC', [planId]);
  const ts = TS();
  rows.forEach((r, idx) => {
    run('UPDATE training_plan_lessons SET seq = ?, updated_at = ? WHERE id = ?', [idx + 1, ts, r.id]);
  });
  const total = rows.length;
  const used = rows.filter(r => r.status === 'completed').length;
  const newStatus = total > 0 && used >= total ? 'completed' : 'active';
  run('UPDATE training_plans SET total_lessons = ?, used_lessons = ?, status = ?, updated_at = ? WHERE id = ?', [total, used, newStatus, ts, planId]);
}

function updatePlanLesson(planId, lessonId, payload) {
  requirePlan(planId);
  const row = requirePlanLesson(planId, lessonId);
  if (row.status === 'completed') {
    throw new HttpError(409, 'LESSON_LOCKED', '该课次已上完并锁定历史教案与评分快照，不可修改或覆盖');
  }
  const cfg = v3Curriculum.getConfig();
  const nextCode = payload.moduleCode ? String(payload.moduleCode) : row.module_code;
  const mod = getModuleByCode(cfg, nextCode);
  if (!mod) throw new HttpError(422, 'UNKNOWN_MODULE', `大纲中不存在模块: ${nextCode}`);

  let secCode = row.secondary_module_code;
  if (payload.secondaryModuleCode !== undefined) {
    secCode = payload.secondaryModuleCode ? String(payload.secondaryModuleCode) : null;
    if (secCode && !getModuleByCode(cfg, secCode)) {
      throw new HttpError(422, 'UNKNOWN_MODULE', `大纲中不存在合练副模块: ${secCode}`);
    }
  }

  const plannedDate = payload.plannedDate !== undefined ? (payload.plannedDate ? String(payload.plannedDate).slice(0, 10) : null) : row.planned_date;
  const minutes = payload.minutes !== undefined ? Math.max(30, Math.min(180, Number(payload.minutes) || 60)) : row.minutes;
  const isRemedial = payload.isRemedial !== undefined ? (payload.isRemedial ? 1 : 0) : row.is_remedial;
  const coachNote = payload.coachNote !== undefined ? String(payload.coachNote) : (row.coach_note || '');
  const ts = TS();

  run(
    `UPDATE training_plan_lessons
     SET module_code = ?, secondary_module_code = ?, module_snapshot_json = ?, planned_date = ?, minutes = ?, is_remedial = ?, coach_note = ?, updated_at = ?
     WHERE id = ?`,
    [mod.code, secCode, JSON.stringify(mod), plannedDate, minutes, isRemedial, coachNote, ts, lessonId]
  );
  meta.bump();
  return getPlanDetail(planId);
}

function insertPlanLesson(planId, payload) {
  const plan = requirePlan(planId);
  const cfg = v3Curriculum.getConfig();
  const mod = getModuleByCode(cfg, payload.moduleCode);
  if (!mod) throw new HttpError(422, 'UNKNOWN_MODULE', `大纲中不存在模块: ${payload.moduleCode}`);
  let secCode = payload.secondaryModuleCode ? String(payload.secondaryModuleCode) : null;
  if (secCode && !getModuleByCode(cfg, secCode)) {
    throw new HttpError(422, 'UNKNOWN_MODULE', `大纲中不存在合练副模块: ${secCode}`);
  }

  const allLessons = all('SELECT * FROM training_plan_lessons WHERE plan_id = ? ORDER BY seq ASC', [planId]);
  let insertAfterSeq = allLessons.length;
  if (payload.afterLessonId) {
    const anchor = allLessons.find(l => l.id === payload.afterLessonId);
    if (!anchor) throw new HttpError(404, 'LESSON_NOT_FOUND', '找不到插入锚点课次');
    insertAfterSeq = anchor.seq;
  } else {
    const lastLocked = [...allLessons].reverse().find(l => l.status === 'completed');
    if (lastLocked && payload.atStartOfPlanned) insertAfterSeq = lastLocked.seq;
  }

  // 检查禁止插在已上完课次之前
  const lockedAfter = allLessons.some(l => l.status === 'completed' && l.seq > insertAfterSeq);
  if (lockedAfter) {
    throw new HttpError(409, 'LESSON_LOCKED', '不能在已上完并锁定的课次之前插入新课次');
  }

  const ts = TS();
  const newIdVal = newId('LES');
  transaction(() => {
    for (const l of allLessons) {
      if (l.seq > insertAfterSeq) {
        run('UPDATE training_plan_lessons SET seq = ?, updated_at = ? WHERE id = ?', [l.seq + 1, ts, l.id]);
      }
    }
    run(
      `INSERT INTO training_plan_lessons
        (id, plan_id, seq, module_code, secondary_module_code, module_snapshot_json, planned_date, minutes, is_remedial, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?)`,
      [
        newIdVal, planId, insertAfterSeq + 1, mod.code, secCode, JSON.stringify(mod),
        payload.plannedDate ? String(payload.plannedDate).slice(0, 10) : null,
        Math.max(30, Math.min(180, Number(payload.minutes) || plan.default_minutes || 60)),
        payload.isRemedial ? 1 : 0,
        ts, ts
      ]
    );
    resequencePlanLessons(planId);
  });

  meta.bump();
  return getPlanDetail(planId);
}

function deletePlanLesson(planId, lessonId) {
  requirePlan(planId);
  const row = requirePlanLesson(planId, lessonId);
  if (row.status === 'completed') {
    throw new HttpError(409, 'LESSON_LOCKED', '已上完课次不可删除');
  }
  const allLessons = all('SELECT id FROM training_plan_lessons WHERE plan_id = ?', [planId]);
  if (allLessons.length <= 1) {
    throw new HttpError(422, 'INVALID_PLAN', '教学计划至少保留 1 节课次');
  }
  transaction(() => {
    run('DELETE FROM training_plan_lessons WHERE id = ?', [lessonId]);
    resequencePlanLessons(planId);
  });
  meta.bump();
  return getPlanDetail(planId);
}

function reorderPlanLessons(planId, orderedLessonIds) {
  requirePlan(planId);
  if (!Array.isArray(orderedLessonIds) || !orderedLessonIds.length) {
    throw new HttpError(422, 'INVALID_REORDER', '请提供完整的课次顺序 ID 数组');
  }
  const rows = all('SELECT * FROM training_plan_lessons WHERE plan_id = ? ORDER BY seq ASC', [planId]);
  if (orderedLessonIds.length !== rows.length) {
    throw new HttpError(422, 'INVALID_REORDER', '课次数量不匹配');
  }
  const byId = new Map(rows.map(r => [r.id, r]));
  for (const id of orderedLessonIds) {
    if (!byId.has(id)) throw new HttpError(422, 'INVALID_REORDER', `无效课次 ID: ${id}`);
  }

  // 校验所有已上完课次位置不可变动
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].status === 'completed' && orderedLessonIds[i] !== rows[i].id) {
      throw new HttpError(409, 'LESSON_LOCKED', `第 ${rows[i].seq} 节已上完并锁定，不可调整其顺序`);
    }
  }

  const ts = TS();
  transaction(() => {
    orderedLessonIds.forEach((id, idx) => {
      run('UPDATE training_plan_lessons SET seq = ?, updated_at = ? WHERE id = ?', [idx + 1, ts, id]);
    });
    run('UPDATE training_plans SET updated_at = ? WHERE id = ?', [ts, planId]);
  });
  meta.bump();
  return getPlanDetail(planId);
}

function extendPlan(planId, payload) {
  const plan = requirePlan(planId);
  const addCount = Math.max(1, Math.min(100, Math.round(Number(payload.addLessons) || 1)));
  const cfg = v3Curriculum.getConfig();
  const studentIds = getPlanStudentsDetailed(planId).map(s => s.id);
  const existing = all('SELECT * FROM training_plan_lessons WHERE plan_id = ? ORDER BY seq ASC', [planId]);
  const lastDate = existing.length ? existing[existing.length - 1].planned_date : TS().slice(0, 10);

  let codes = Array.isArray(payload.moduleCodes) ? payload.moduleCodes.filter(c => getModuleByCode(cfg, c)) : [];
  if (!codes.length) {
    codes = pickInitialCodes(cfg, studentIds, addCount, payload.trackMode || plan.track_mode, payload.bundleId, null).map(x => x.code);
  }

  const ts = TS();
  transaction(() => {
    for (let i = 0; i < addCount; i++) {
      const code = codes[i % codes.length];
      const mod = getModuleByCode(cfg, code) || cfg.modules[0];
      const lId = newId('LES');
      const pDate = lastDate ? addDays(lastDate, (i + 1) * 7) : null;
      run(
        `INSERT INTO training_plan_lessons
          (id, plan_id, seq, module_code, secondary_module_code, module_snapshot_json, planned_date, minutes, is_remedial, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 0, 'planned', ?, ?)`,
        [lId, planId, existing.length + i + 1, mod.code, JSON.stringify(mod), pDate, plan.default_minutes || 60, ts, ts]
      );
    }
    resequencePlanLessons(planId);
  });
  meta.bump();
  return getPlanDetail(planId);
}

function completePlanLesson(planId, lessonId, payload) {
  const plan = requirePlan(planId);
  const row = requirePlanLesson(planId, lessonId);
  if (row.status === 'completed') {
    throw new HttpError(409, 'LESSON_LOCKED', '该课次已结算完成并锁定');
  }

  const detail = getLessonDetail(planId, lessonId);
  const planStudents = detail.students;
  const studentMap = new Map(planStudents.map(s => [s.id, s]));

  const reviewsInput = Array.isArray(payload.studentReviews) ? payload.studentReviews : [];
  if (!reviewsInput.length) {
    throw new HttpError(422, 'MISSING_REVIEWS', '请至少提交 1 位学员的课后出勤与打分结果');
  }

  const completedAt = payload.completedDate ? String(payload.completedDate) : TS();
  const practicedDate = completedAt.slice(0, 10);
  const coachNote = payload.coachNote ? String(payload.coachNote) : (row.coach_note || '');
  const ts = TS();

  const generatedSnapshots = [];

  transaction(() => {
    // 1) 锁定本课次与当时教案快照
    run(
      `UPDATE training_plan_lessons
       SET status = 'completed', coach_note = ?, lesson_plan_snapshot_json = ?, completed_at = ?, updated_at = ?
       WHERE id = ?`,
      [coachNote, JSON.stringify(detail.planContent), completedAt, ts, lessonId]
    );

    // 2) 对班级内每位学员独立结算（出勤才更新对应模块分数+累计练习+自动生成冻结快照；缺席不动分、不扣个人课时）
    for (const rv of reviewsInput) {
      const sid = String(rv.studentId || '');
      if (!studentMap.has(sid)) {
        throw new HttpError(422, 'INVALID_STUDENT', `学员 ${sid} 不属于本教学计划`);
      }
      const attend = rv.attend === 'absent' ? 'absent' : 'present';
      const scoresToApply = {};
      if (rv.scores && typeof rv.scores === 'object') {
        for (const [k, v] of Object.entries(rv.scores)) {
          if (v !== '' && v != null) scoresToApply[k] = Math.max(0, Math.min(5, Math.round(Number(v) || 0)));
        }
      }
      if (rv.score !== undefined && rv.score !== null && rv.score !== '') {
        scoresToApply[row.module_code] = Math.max(0, Math.min(5, Math.round(Number(rv.score) || 0)));
      }
      if (row.secondary_module_code && rv.secondaryScore !== undefined && rv.secondaryScore !== null && rv.secondaryScore !== '') {
        scoresToApply[row.secondary_module_code] = Math.max(0, Math.min(5, Math.round(Number(rv.secondaryScore) || 0)));
      }

      let snapId = null;
      if (attend === 'present') {
        // 默认至少把主模块记 1 次练习（若教练未改分则沿用原分或 1）
        if (scoresToApply[row.module_code] === undefined) {
          const stu = studentMap.get(sid);
          scoresToApply[row.module_code] = Math.max(0, stu.currentModuleScore || 0);
        }
        const upd = v3StudentReports.updateStudentScores(sid, scoresToApply, {
          inTransaction: true,
          incrementPractice: true,
          practicedAt: practicedDate,
          note: rv.feedback ? String(rv.feedback) : '',
          createSnapshot: true,
          triggerType: 'lesson_review',
          planId,
          planLessonId: lessonId,
          summaryNote: `第 ${row.seq} 节「${detail.planContent.moduleCode} ${detail.planContent.moduleTitle}」课后点评${rv.feedback ? '：' + rv.feedback : ''}`
        });
        if (upd.snapshot) {
          snapId = upd.snapshot.id;
          generatedSnapshots.push({ studentId: sid, snapshot: upd.snapshot });
        }
        run(
          `UPDATE training_plan_students SET used_lessons = used_lessons + 1 WHERE plan_id = ? AND student_id = ?`,
          [planId, sid]
        );
      }

      const rvId = newId('LRV');
      const rpeVal = rv.rpe !== undefined && rv.rpe !== null && rv.rpe !== '' ? Math.max(1, Math.min(10, Math.round(Number(rv.rpe)))) : null;
      run(
        `INSERT INTO training_lesson_reviews
          (id, plan_lesson_id, plan_id, student_id, attend, module_scores_json, rpe, homework, feedback, report_snapshot_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(plan_lesson_id, student_id) DO UPDATE SET
           attend = excluded.attend,
           module_scores_json = excluded.module_scores_json,
           rpe = excluded.rpe,
           homework = excluded.homework,
           feedback = excluded.feedback,
           report_snapshot_id = excluded.report_snapshot_id`,
        [
          rvId, lessonId, planId, sid, attend, JSON.stringify(attend === 'present' ? scoresToApply : {}),
          rpeVal, rv.homework ? String(rv.homework) : '', rv.feedback ? String(rv.feedback) : '', snapId, ts
        ]
      );
    }

    resequencePlanLessons(planId);
  });

  meta.bump();
  return {
    plan: getPlanDetail(planId),
    generatedSnapshots
  };
}

function addStudentsToPlan(planId, studentIds) {
  requirePlan(planId);
  const ids = Array.isArray(studentIds) ? [...new Set(studentIds.filter(Boolean))] : [];
  if (!ids.length) throw new HttpError(422, 'INVALID_PLAN', '请选择要加入的学员');
  for (const sid of ids) {
    v3StudentReports.requireStudent(sid);
    run(
      `INSERT OR IGNORE INTO training_plan_students (plan_id, student_id, used_lessons) VALUES (?, ?, 0)`,
      [planId, sid]
    );
  }
  const countRow = get('SELECT COUNT(*) AS c FROM training_plan_students WHERE plan_id = ?', [planId]);
  const pkg = countRow.c === 1 ? 'solo' : countRow.c <= 6 ? 'small' : 'large';
  run('UPDATE training_plans SET package_type = ?, updated_at = ? WHERE id = ?', [pkg, TS(), planId]);
  meta.bump();
  return getPlanDetail(planId);
}

module.exports = {
  listPlans,
  getPlanDetail,
  createPlan,
  getLessonDetail,
  updatePlanLesson,
  insertPlanLesson,
  deletePlanLesson,
  reorderPlanLessons,
  extendPlan,
  completePlanLesson,
  addStudentsToPlan
};
