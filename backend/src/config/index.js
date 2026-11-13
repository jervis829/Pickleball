'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// backend/src/config -> 项目根
const ROOT = path.resolve(__dirname, '..', '..', '..');

function parseEnv(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

const fileEnv = parseEnv(path.join(ROOT, '.env'));
const E = (k, d) => process.env[k] !== undefined
  ? process.env[k]
  : (fileEnv[k] !== undefined ? fileEnv[k] : d);
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

const dataDir = path.join(ROOT, 'data');
fs.mkdirSync(dataDir, { recursive: true });

function persistedSecret(file, bytes, label) {
  const p = path.join(dataDir, file);
  if (fs.existsSync(p)) return { value: fs.readFileSync(p, 'utf8').trim(), generated: false };
  const value = crypto.randomBytes(bytes).toString('hex');
  fs.writeFileSync(p, value, { mode: 0o600 });
  return { value, generated: true };
}

const jwt = persistedSecret('jwt-secret.txt', 48);
let adminPassword = String(E('ADMIN_PASSWORD', ''));
let generatedPassword = false;
if (!adminPassword) {
  const pwFile = path.join(dataDir, 'initial-admin.txt');
  if (fs.existsSync(pwFile)) {
    const first = fs.readFileSync(pwFile, 'utf8').split('\n')[0];
    adminPassword = (first.split(' / ')[1] || '').trim();
  } else {
    adminPassword = crypto.randomBytes(9).toString('base64url');
    fs.writeFileSync(pwFile,
      `首次启动管理员：${E('ADMIN_USER', 'admin')} / ${adminPassword}\n请登录后立即修改密码，然后删除本文件。\n`,
      { mode: 0o600 });
    generatedPassword = true;
  }
}

module.exports = {
  ROOT,
  dataDir,
  port: num(E('PORT', 8787), 8787),
  host: E('HOST', '127.0.0.1'),
  dbFile: path.resolve(ROOT, E('DB_FILE', 'data/pickleball.db')),
  frontendDir: path.join(ROOT, 'frontend'),
  corsOrigins: String(E('CORS_ORIGINS', '')).split(',').map(s => s.trim()).filter(Boolean),
  jwtSecret: jwt.value,
  jwtTtlSeconds: num(E('JWT_TTL_SECONDS', 900), 900),
  adminUser: String(E('ADMIN_USER', 'admin')),
  adminPassword,
  generatedPassword,
  rateLimit: {
    windowMs: num(E('RATE_LIMIT_WINDOW_MS', 60000), 60000),
    max: num(E('RATE_LIMIT_MAX', 600), 600)
  },
  isProduction: E('NODE_ENV', 'development') === 'production',
  logLevel: E('LOG_LEVEL', 'info')
};
