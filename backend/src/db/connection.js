'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');

let db = null;

function getDb() {
  if (db) return db;
  fs.mkdirSync(path.dirname(config.dbFile), { recursive: true });
  db = new DatabaseSync(config.dbFile);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA synchronous = NORMAL;');
  return db;
}

const closeDb = () => { if (db) { db.close(); db = null; } };
const prepare = (sql) => getDb().prepare(sql);
const run = (sql, params = []) => prepare(sql).run(...params);
const all = (sql, params = []) => prepare(sql).all(...params);
const get = (sql, params = []) => prepare(sql).get(...params);

/** 单事务包装；失败自动回滚。业务层不得嵌套调用。 */
function transaction(fn) {
  const d = getDb();
  d.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    d.exec('COMMIT');
    return result;
  } catch (err) {
    try { d.exec('ROLLBACK'); } catch (_) { /* 已回滚 */ }
    throw err;
  }
}

module.exports = { getDb, closeDb, prepare, run, all, get, transaction };
