'use strict';
const { run, all, get } = require('../db/connection');
const { newId, hashPassword } = require('../utils/crypto');
const config = require('../config');

const TS = () => new Date().toISOString();

/* ---------- users ---------- */
const users = {
  count: () => get('SELECT COUNT(*) AS c FROM users WHERE deleted_at IS NULL').c,
  findByUsername: (username) => get('SELECT * FROM users WHERE username = ? AND deleted_at IS NULL', [username]),
  findById: (id) => get('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL', [id]),
  createAdmin: () => {
    const { salt, password_hash } = hashPassword(config.adminPassword);
    const id = newId('U'), ts = TS();
    run(`INSERT INTO users (id, username, password_hash, salt, role, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'admin', 1, ?, ?)`,
      [id, config.adminUser, password_hash, salt, ts, ts]);
    return { id, username: config.adminUser, role: 'admin' };
  },
  updatePassword: (id, password) => {
    const { salt, password_hash } = hashPassword(password);
    run('UPDATE users SET password_hash=?, salt=?, updated_at=? WHERE id=?', [password_hash, salt, TS(), id]);
  },
  public: (u) => ({ id: u.id, username: u.username, role: u.role })
};

/* ---------- settings（键值） ---------- */
const settings = {
  get: (key, fallback = null) => {
    const row = get('SELECT value_json FROM settings WHERE key = ?', [key]);
    if (!row) return fallback;
    try { return JSON.parse(row.value_json); } catch (_) { return fallback; }
  },
  set: (key, value) => {
    run(`INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`,
      [key, JSON.stringify(value), TS()]);
  },
  all: () => Object.fromEntries(all('SELECT key, value_json FROM settings').map(r => {
    try { return [r.key, JSON.parse(r.value_json)]; } catch (_) { return [r.key, null]; }
  }))
};

/* ---------- curriculum（24 教学单元） ---------- */
const curriculum = {
  list: () => all('SELECT * FROM curriculum_units ORDER BY unit_no ASC').map(r => ({
    u: r.unit_no, s: r.stage, tech: r.tech, a: r.focus_a, b: r.focus_b,
    fit: r.fit, foot: r.foot, org: r.org, play: r.play, hw: r.hw,
    err: r.err, fix: r.fix, kp: r.kp, drill: r.drill
  })),
  replaceAll: (units) => {
    const ts = TS();
    run('DELETE FROM curriculum_units');
    const stmt = `INSERT INTO curriculum_units
      (unit_no, stage, tech, focus_a, focus_b, fit, foot, org, play, hw, err, fix, kp, drill, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(unit_no) DO UPDATE SET stage=excluded.stage, tech=excluded.tech,
        focus_a=excluded.focus_a, focus_b=excluded.focus_b, fit=excluded.fit, foot=excluded.foot,
        org=excluded.org, play=excluded.play, hw=excluded.hw, err=excluded.err, fix=excluded.fix,
        kp=excluded.kp, drill=excluded.drill, updated_at=excluded.updated_at`;
    for (const u of units) {
      run(stmt, [u.u, u.s, u.tech, u.a, u.b, u.fit, u.foot, u.org, u.play, u.hw, u.err, u.fix, u.kp, u.drill, ts, ts]);
    }
    return curriculum.list().length;
  }
};

/* ---------- audit / revision ---------- */
const audit = {
  write: (ctx, action) => {
    run('INSERT INTO audit_logs (actor, method, path, status, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [ctx.user ? ctx.user.sub : 'anonymous', ctx.req.method, ctx.path, ctx.res.statusCode || 0, action || '', TS()]);
  }
};

const meta = {
  revision: () => get('SELECT revision FROM state_meta WHERE id = 1').revision,
  bump: () => {
    run('UPDATE state_meta SET revision = revision + 1, updated_at = ? WHERE id = 1', [TS()]);
    return meta.revision();
  }
};

module.exports = { users, settings, curriculum, audit, meta };
