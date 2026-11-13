'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { migrate } = require('../../backend/src/db/migrate');
const { curriculum } = require('../../backend/src/repositories/misc');
const { ensureAdmin } = require('../../backend/src/services/auth');

/**
 * 幂等种子：写入 24 教学单元（数据源：匹克球训练体系_初学者到高阶.md v2）
 * 首次运行同时创建管理员账号。可独立执行：npm run seed
 */
function seed(opts = {}) {
  if (!opts.skipMigrate) migrate();
  let admin = null;
  if (!opts.skipAdmin) admin = ensureAdmin();
  const file = path.join(__dirname, 'curriculum.json');
  const units = JSON.parse(fs.readFileSync(file, 'utf8'));
  const count = curriculum.replaceAll(units);
  return { units: count, admin_created: Boolean(admin), source: file };
}

if (require.main === module) {
  try {
    const r = seed();
    console.log(`[seed] 完成：${r.units} 个教学单元，管理员创建=${r.admin_created}`);
  } catch (e) {
    console.error('[seed] 失败：', e.message);
    process.exitCode = 1;
  }
}

module.exports = { seed };
