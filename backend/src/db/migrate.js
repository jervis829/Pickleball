'use strict';
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const { getDb, closeDb } = require('./connection');

/** 幂等迁移：按文件名顺序执行未应用的 SQL，版本记录入库。 */
function migrate() {
  const db = getDb();
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const dir = path.join(config.ROOT, 'database', 'migrations');
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map(r => r.version));
  const done = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(file, new Date().toISOString());
      db.exec('COMMIT');
      done.push(file);
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch (_) { /* noop */ }
      throw new Error(`迁移 ${file} 失败：${err.message}`);
    }
  }
  return { applied: done, total: files.length };
}

if (require.main === module) {
  try {
    const r = migrate();
    console.log(`[migrate] 完成：新增 ${r.applied.length} / 共 ${r.total} 个迁移`);
  } catch (e) {
    console.error('[migrate] 失败：', e.message);
    process.exitCode = 1;
  } finally { closeDb(); }
}

module.exports = { migrate };
