'use strict';
const config = require('../config');
const { fail, HttpError } = require('../utils/response');
const logger = require('../utils/logger');
const { parseAuth, requireAuth, requireWrite } = require('./auth');

const BODY_LIMIT = 5 * 1024 * 1024; // 5 MB

function applySecurity(ctx) {
  const h = ctx.res;
  // 默认禁止被嵌入（防点击劫持）。仅当显式配置了 ALLOW_EMBED_ORIGINS 时才放开，
  // 用于在云预览 / 内嵌工作台等可信宿主里显示界面；放开范围按白名单精确匹配，不用 *。
  const embedOrigins = config.allowEmbedOrigins || [];
  const frameAncestors = embedOrigins.length
    ? "frame-ancestors 'self' " + embedOrigins.join(' ')
    : "frame-ancestors 'none'";
  const headers = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    // 前端为单文件应用（含内联脚本/样式）；抽离后才可升级为严格 nonce CSP
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self' 'unsafe-inline'; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data:; " +
      "connect-src 'self'; " + frameAncestors + "; base-uri 'self'",
    'Cache-Control': 'no-store',
    'Pragma': 'no-cache'
  };
  // 未显式放开时保留 DENY（比 ALLOW-FROM 更可靠，且是被审计的默认值）
  if (!embedOrigins.length) headers['X-Frame-Options'] = 'DENY';
  for (const [k, v] of Object.entries(headers)) h.setHeader(k, v);
}

/**
 * 与当前请求同源的候选来源。
 * 浏览器访问经 HTTPS 反代时，Origin 是 https://域名，而后端只知道 127.0.0.1:8787；
 * 用反代传入的 Host / X-Forwarded-Host 推导同源来源，避免把本站自己判成跨域。
 * 仅按「请求实际到达的 Host」推导，不反射任意 Origin，恶意站点仍被拒绝。
 */
function sameOriginOrigins(ctx) {
  const h = ctx.req.headers;
  const host = String(h['x-forwarded-host'] || h.host || '').split(',')[0].trim().toLowerCase();
  if (!host) return [];
  // 反代同时承载 80/443 时协议可能不同；同 Host 的两种协议都视为本站同源
  return ['http://' + host, 'https://' + host];
}

/** 返回 false 表示已结束响应 */
function applyCors(ctx) {
  const origin = ctx.req.headers.origin;
  if (!origin) return true;
  const allowed = new Set([
    ...config.corsOrigins,
    ...sameOriginOrigins(ctx),
    `http://${config.host}:${config.port}`,
    'http://localhost:' + config.port,
    'http://127.0.0.1:' + config.port
  ]);
  if (!allowed.has(origin)) {
    fail(ctx.res, 403, 'CORS_FORBIDDEN', '来源不在白名单：' + origin);
    return false;
  }
  ctx.res.setHeader('Access-Control-Allow-Origin', origin);
  ctx.res.setHeader('Vary', 'Origin');
  ctx.res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  ctx.res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-PKB-Auth, X-PKB-Session');
  if (ctx.req.method === 'OPTIONS') { ctx.res.writeHead(204); ctx.res.end(); return false; }
  return true;
}

const buckets = new Map();
function applyRateLimit(ctx) {
  const ip = ctx.req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const w = config.rateLimit.windowMs;
  const rec = buckets.get(ip);
  if (!rec || now - rec.start > w) { buckets.set(ip, { start: now, count: 1 }); return true; }
  rec.count += 1;
  if (rec.count > config.rateLimit.max) {
    fail(ctx.res, 429, 'RATE_LIMITED', '请求过于频繁，请稍后重试');
    return false;
  }
  return true;
}

async function parseBody(ctx) {
  if (!['POST', 'PUT', 'PATCH'].includes(ctx.req.method)) return;
  let size = 0;
  const chunks = [];
  for await (const chunk of ctx.req) {
    size += chunk.length;
    if (size > BODY_LIMIT) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', '请求体不得超过 5 MB');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) { ctx.body = {}; return; }
  try { ctx.body = JSON.parse(raw); }
  catch (_) { throw new HttpError(400, 'INVALID_JSON', '请求体不是合法 JSON'); }
}

function handleError(ctx, err) {
  ctx.status = err instanceof HttpError ? err.status : 500;
  if (ctx.status >= 500) logger.error('unhandled.error', { message: err.message, stack: config.isProduction ? undefined : err.stack });
  if (ctx.res.writableEnded) return;
  if (err instanceof HttpError) fail(ctx.res, ctx.status, err.code, err.message, err.details);
  else fail(ctx.res, 500, 'INTERNAL_ERROR', config.isProduction ? '服务器内部错误' : err.message);
}

function createContext(req, res) {
  const url = new URL(req.url, 'http://localhost');
  return {
    req, res,
    path: decodeURIComponent(url.pathname),
    query: Object.fromEntries(url.searchParams.entries()),
    params: {},
    body: null,
    user: null,
    status: 200,
    requestId: Math.random().toString(36).slice(2, 10),
    start: Date.now()
  };
}

/** 请求前置链；返回 false 表示响应已结束 */
async function prepare(ctx) {
  applySecurity(ctx);
  if (!applyCors(ctx)) return false;
  if (!applyRateLimit(ctx)) return false;
  parseAuth(ctx);
  await parseBody(ctx);
  return true;
}

function finalize(ctx) {
  if (!ctx.res.writableFinished) return;
  logger.request(ctx, ctx.res.statusCode, Date.now() - ctx.start);
}

module.exports = { prepare, finalize, handleError, createContext, requireAuth, requireWrite, applySecurity };
