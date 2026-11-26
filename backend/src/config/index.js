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
  // 允许把界面嵌入到哪些宿主来源（云预览 / 内嵌工作台）。留空 = 禁止被嵌入（默认）。
  // 只接受精确的 https 来源或本机 http，避免出现 * 或过于宽泛的通配。
  // 允许 https 精确来源、https 子域通配（https://*.example.com，CSP host-source 合法写法）
  // 或本机 http；拒绝裸 * 与 http 公网来源。
  allowEmbedOrigins: String(E('ALLOW_EMBED_ORIGINS', '')).split(',')
    .map(s => s.trim())
    .filter(s => /^https:\/\/(\*\.)?[^\s*/]+$/.test(s) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(s)),
  jwtSecret: jwt.value,
  // 12 小时：球馆一天营业时长。原来的 900 秒会让教练每 15 分钟被弹一次登录框，
  // 而界面上任何一次自动同步都会触发它。安全边界仍由「单馆本机部署 + 可改密」保证。
  jwtTtlSeconds: Math.max(300, num(E('JWT_TTL_SECONDS', 43200), 43200)),
  // 允许在令牌到期后多久内仍然换发新令牌（应对笔记本合盖、标签页休眠后回来）。
  jwtRefreshGraceSeconds: Math.max(0, num(E('JWT_REFRESH_GRACE_SECONDS', 3600), 3600)),
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
