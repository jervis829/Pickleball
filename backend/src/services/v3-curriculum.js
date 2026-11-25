'use strict';
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const { get, run } = require('../db/connection');
const { meta } = require('../repositories/misc');
const { HttpError } = require('../utils/response');

const TS = () => new Date().toISOString();
const SEED_FILE = path.join(config.ROOT, 'database', 'seeds', 'curriculum-config.json');

let seedCache = null;
function readSeedConfig() {
  if (seedCache) return JSON.parse(JSON.stringify(seedCache));
  if (!fs.existsSync(SEED_FILE)) {
    throw new HttpError(500, 'CURRICULUM_CONFIG_MISSING', '缺少课程配置种子 database/seeds/curriculum-config.json');
  }
  seedCache = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  return JSON.parse(JSON.stringify(seedCache));
}

function validateConfig(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new HttpError(422, 'INVALID_CURRICULUM_CONFIG', '大纲配置必须是 JSON 对象');
  }
  if (!String(cfg.version || '').trim()) {
    throw new HttpError(422, 'INVALID_CURRICULUM_CONFIG', '大纲配置缺少 version 版本号');
  }
  if (!Array.isArray(cfg.tracks) || !cfg.tracks.length) {
    throw new HttpError(422, 'INVALID_CURRICULUM_CONFIG', 'tracks 必须是非空数组');
  }
  const trackIds = new Set();
  for (const t of cfg.tracks) {
    if (!t || !String(t.id || '').trim() || !String(t.name || '').trim()) {
      throw new HttpError(422, 'INVALID_CURRICULUM_CONFIG', '每个 track 必须包含 id 和 name');
    }
    if (trackIds.has(t.id)) {
      throw new HttpError(422, 'INVALID_CURRICULUM_CONFIG', `重复的 track id: ${t.id}`);
    }
    trackIds.add(t.id);
  }
  if (!Array.isArray(cfg.categories) || !cfg.categories.length) {
    throw new HttpError(422, 'INVALID_CURRICULUM_CONFIG', 'categories 必须是非空数组');
  }
  const catIds = new Set();
  for (const c of cfg.categories) {
    if (!c || !String(c.id || '').trim() || !String(c.name || '').trim()) {
      throw new HttpError(422, 'INVALID_CURRICULUM_CONFIG', '每个技术分类必须包含 id 和 name');
    }
    if (catIds.has(c.id)) {
      throw new HttpError(422, 'INVALID_CURRICULUM_CONFIG', `重复的分类 id: ${c.id}`);
    }
    catIds.add(c.id);
  }
  if (!Array.isArray(cfg.modules) || !cfg.modules.length) {
    throw new HttpError(422, 'INVALID_CURRICULUM_CONFIG', 'modules 必须是非空数组');
  }
  const modCodes = new Set();
  for (const m of cfg.modules) {
    if (!m || !String(m.code || '').trim() || !String(m.title || '').trim()) {
      throw new HttpError(422, 'INVALID_CURRICULUM_CONFIG', '每个技术模块必须包含 code 和 title');
    }
    if (modCodes.has(m.code)) {
      throw new HttpError(422, 'INVALID_CURRICULUM_CONFIG', `重复的模块编号: ${m.code}`);
    }
    modCodes.add(m.code);
    if (!trackIds.has(m.track)) {
      throw new HttpError(422, 'INVALID_CURRICULUM_CONFIG', `模块 ${m.code} 引用了未知阶位 track: ${m.track}`);
    }
    if (!catIds.has(m.categoryId)) {
      throw new HttpError(422, 'INVALID_CURRICULUM_CONFIG', `模块 ${m.code} 引用了未知分类 categoryId: ${m.categoryId}`);
    }
    const diff = Number(m.difficulty);
    if (!Number.isFinite(diff) || diff < 1 || diff > 5) {
      throw new HttpError(422, 'INVALID_CURRICULUM_CONFIG', `模块 ${m.code} 的 difficulty 必须为 1-5`);
    }
    if (!Array.isArray(m.kp) || !m.kp.length) {
      throw new HttpError(422, 'INVALID_CURRICULUM_CONFIG', `模块 ${m.code} 至少包含 1 条判据 kp`);
    }
    if (!m.plan60 || !Array.isArray(m.plan60.drills) || !m.plan60.drills.length) {
      throw new HttpError(422, 'INVALID_CURRICULUM_CONFIG', `模块 ${m.code} 缺少 60 分钟教案模板 plan60.drills`);
    }
  }
  for (const b of cfg.bundles || []) {
    for (const c of b.codes || []) {
      if (!modCodes.has(c)) {
        throw new HttpError(422, 'INVALID_CURRICULUM_CONFIG', `组合包 ${b.id || b.name} 引用了不存在的模块: ${c}`);
      }
    }
  }
  return true;
}

function getConfig() {
  try {
    const row = get('SELECT config_json FROM curriculum_config_store WHERE id = 1');
    if (row && row.config_json) return JSON.parse(row.config_json);
  } catch (_) {
    // 迁移前或只读检查时回退到种子配置
  }
  return readSeedConfig();
}

function saveConfig(newConfig) {
  validateConfig(newConfig);
  const ts = TS();
  const payload = JSON.stringify(newConfig);
  run(`INSERT INTO curriculum_config_store (id, version, config_json, updated_at)
       VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET version=excluded.version, config_json=excluded.config_json, updated_at=excluded.updated_at`,
    [String(newConfig.version), payload, ts]);
  const revision = meta.bump();
  return { config: newConfig, revision };
}

function resetConfig() {
  const def = readSeedConfig();
  return saveConfig(def);
}

/**
 * 7 大技术类别 0–10 分自动计算（配置驱动，支持未来配置新增高阶轨道）：
 *   - 顺序型轨道（如 basic 初阶，weightMax=6）：该类别下全部该轨道模块平均分 / 5 * 权重
 *   - 选修型轨道（如 advanced 进阶，weightMax=4）：取该类别下得分最高的 K 个模块（K=min(轨道模块数, advTopK||2)）平均 / 5 * 权重
 *   - 总分归一化到 0.0–10.0（保留 1 位小数）
 */
function computeCategoryScores(moduleScoreMap, cfgInput) {
  const cfg = cfgInput || getConfig();
  const scoreOf = (code) => {
    const raw = moduleScoreMap instanceof Map ? moduleScoreMap.get(code) : (moduleScoreMap ? moduleScoreMap[code] : 0);
    const n = Number(raw);
    return Number.isFinite(n) ? Math.max(0, Math.min(5, Math.round(n))) : 0;
  };
  const tracks = (cfg.tracks || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  const categories = (cfg.categories || []).slice().sort((a, b) => (a.order || 0) - (b.order || 0));
  const modules = (cfg.modules || []).slice().sort((a, b) => (a.seq || 0) - (b.seq || 0));

  const outCategories = categories.map(cat => {
    const catModules = modules.filter(m => m.categoryId === cat.id);
    const weights = cat.trackWeights || Object.fromEntries(tracks.map(t => [t.id, t.weightMax || 0]));
    const activeTracks = tracks.filter(t => catModules.some(m => m.track === t.id) && Number(weights[t.id] || 0) > 0);
    const rawWeightSum = activeTracks.reduce((a, t) => a + Number(weights[t.id] || 0), 0) || 1;
    const scaleTo10 = 10 / rawWeightSum;

    let categoryScore = 0;
    const trackBreakdown = {};
    for (const tr of activeTracks) {
      const trMods = catModules.filter(m => m.track === tr.id);
      const w = Number(weights[tr.id] || 0) * scaleTo10;
      let earned = 0;
      if (tr.mode === 'elective') {
        const k = Math.max(1, Math.min(trMods.length, Number(cat.advTopK) || 2));
        const topScores = trMods.map(m => scoreOf(m.code)).sort((a, b) => b - a).slice(0, k);
        const avg = topScores.reduce((a, b) => a + b, 0) / (k * 5);
        earned = avg * w;
      } else {
        const sum = trMods.reduce((a, m) => a + scoreOf(m.code), 0);
        const avg = trMods.length ? (sum / (trMods.length * 5)) : 0;
        earned = avg * w;
      }
      categoryScore += earned;
      trackBreakdown[tr.id] = {
        trackName: tr.name,
        earned: Math.round(earned * 10) / 10,
        max: Math.round(w * 10) / 10,
        learnedCount: trMods.filter(m => scoreOf(m.code) >= 1).length,
        masteredCount: trMods.filter(m => scoreOf(m.code) >= 2).length,
        totalCount: trMods.length
      };
    }

    const basicMods = catModules.filter(m => m.track === 'basic');
    const advMods = catModules.filter(m => m.track !== 'basic');
    return {
      id: cat.id,
      name: cat.name,
      order: cat.order,
      score: Math.round(categoryScore * 10) / 10,
      maxScore: 10,
      basicLearned: basicMods.filter(m => scoreOf(m.code) >= 1).length,
      basicMastered: basicMods.filter(m => scoreOf(m.code) >= 2).length,
      basicTotal: basicMods.length,
      advLearned: advMods.filter(m => scoreOf(m.code) >= 1).length,
      advMastered: advMods.filter(m => scoreOf(m.code) >= 2).length,
      advTotal: advMods.length,
      trackBreakdown,
      modules: catModules.map(m => ({
        code: m.code,
        title: m.title,
        track: m.track,
        seq: m.seq,
        difficulty: m.difficulty,
        score: scoreOf(m.code)
      }))
    };
  });

  const overallScore = outCategories.length
    ? Math.round((outCategories.reduce((a, c) => a + c.score, 0) / outCategories.length) * 10) / 10
    : 0;

  return { categories: outCategories, overallScore };
}

module.exports = {
  readSeedConfig, validateConfig, getConfig, saveConfig, resetConfig, computeCategoryScores
};
