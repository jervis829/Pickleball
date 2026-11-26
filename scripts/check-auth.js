/* 登录会话自检：真实服务端 + 真实 frontend/api.js，验证「不再反复弹登录框」。
 *
 * 背景（线上真实故障）：教练登录后，上课途中登录框会反复弹出。原因是两件事叠加：
 *   1. 令牌有效期只有 15 分钟，一节课上到一半就过期；
 *   2. 前端收到 401 就无条件弹登录框，而 450ms 防抖同步、启动拉取、
 *      标签页可见性检查都会触发请求 —— 于是弹窗密集出现。
 * 另外在 sandbox iframe 里 localStorage 会抛 SecurityError，令牌存不住。
 *
 * 本脚本把 api.js 放进 VM，配真实 HTTP 服务与可配置的存储环境，逐条固定这些契约。
 * 弹框判定：document.body.appendChild 收到 id === 'pkbLogin' 的次数。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const TTL = 2; // 秒，让令牌快速过期以缩短用例时间
const PASSWORD = 'check-password-123';

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; return; }
  fail++;
  console.log('  FAIL:', name, extra === undefined ? '' : JSON.stringify(extra));
};

/* 造一个「能跑起来的最小 DOM」，够 promptLogin 走完表单提交 */
function makeEnv({ base, storage }) {
  const counters = { modalOpens: 0, lastLayout: null, submit: null };
  const stub = (tag) => {
    const node = {
      tagName: String(tag || 'div').toUpperCase(), id: '', innerHTML: '', textContent: '', value: '',
      style: {}, dataset: {}, elements: {}, handlers: {},
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute() {}, getAttribute() { return null; },
      addEventListener(type, fn) { (this.handlers[type] = this.handlers[type] || []).push(fn); },
      remove() {}, appendChild() {}, dispatchEvent() {},
      _children: Object.create(null),
      querySelector(sel) {
        if (!this._children[sel]) this._children[sel] = stub(sel.replace(/^\./, ''));
        return this._children[sel];
      },
      querySelectorAll() { return []; },
      focus() {}, click() {}, closest() { return null; }
    };
    return node;
  };
  const body = {
    appendChild(node) {
      counters.lastLayout = node;
      if (node && node.id === 'pkbLogin') counters.modalOpens += 1;
    },
    removeChild() {}
  };
  const document = {
    body,
    visibilityState: 'visible',
    addEventListener() {},
    createElement: stub,
    dispatchEvent() {},
    querySelector() { return null; },
    querySelectorAll() { return []; }
  };
  const ctx = {
    console, document,
    // api.js 内部 BASE 已经是 '/api/v1'，这里不要再拼一次，否则会 404
    fetch: (url, opts) => fetch(base + url, opts),
    setTimeout, clearTimeout, clearInterval,
    setInterval: () => ({ unref() {} }),
    Date, Math, JSON, Number, String, Boolean, Array, Object, Promise, RegExp, Error,
    CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } },
    Blob: class {}, URL: { createObjectURL: () => '', revokeObjectURL() {} },
    navigator: {}, location: { reload() {} }
  };
  ctx.localStorage = storage.localStorage;
  ctx.sessionStorage = storage.sessionStorage;
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'frontend', 'api.js'), 'utf8'), ctx, { filename: 'api.js' });

  // 登录遮罩内部通过 wrap.querySelector('form') 取表单并注册 submit。
  // stub 的 querySelector 已按选择器缓存子节点，因此这里能拿到同一个对象：
  // 把它的 elements 填成「已输入账号密码」的状态即可模拟用户提交。
  return {
    ctx, counters,
    API: ctx.PKB_API,
    async submitLogin() {
      const layout = counters.lastLayout;
      if (!layout || layout.id !== 'pkbLogin') throw new Error('登录框没有出现');
      const form = layout.querySelector('form');
      const input = (v) => ({ value: v, focus() {} });
      form.elements = { username: input('admin'), password: input(PASSWORD) };
      const fn = (form.handlers.submit || [])[0];
      if (!fn) throw new Error('登录框没有挂上提交处理器');
      await fn({ preventDefault() {} });
    },
    /* 点「离线继续」：这是教练在课上最常用的逃生口，必须真的关闭弹框 */
    clickOffline() {
      const layout = counters.lastLayout;
      if (!layout || layout.id !== 'pkbLogin') throw new Error('登录框没有出现');
      const ghost = layout.querySelector('.ghost');
      const fn = (ghost.handlers.click || [])[0];
      if (!fn) throw new Error('登录框没有挂上「离线继续」处理器');
      fn({ preventDefault() {} });
    }
  };
}

function storageOk(seed = {}) {
  const mk = (init) => {
    const m = Object.assign({}, init);
    return {
      getItem: (k) => (k in m ? m[k] : null),
      setItem: (k, v) => { m[k] = String(v); },
      removeItem: (k) => { delete m[k]; },
      _dump: () => m
    };
  };
  return { localStorage: mk(seed), sessionStorage: mk({}), kind: 'localStorage' };
}

/* 第三方 iframe：localStorage / sessionStorage 一律抛 SecurityError */
function storageBlocked() {
  const boom = () => { const e = new Error('The operation is insecure.'); e.name = 'SecurityError'; throw e; };
  const guard = { getItem: boom, setItem: boom, removeItem: boom };
  return { localStorage: guard, sessionStorage: guard, kind: 'memory' };
}

async function main() {
  const dbFile = path.join(os.tmpdir(), 'pkb-auth-check.db');
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbFile + s); } catch (_) {} }
  Object.assign(process.env, {
    DB_FILE: dbFile, ADMIN_USER: 'admin', ADMIN_PASSWORD: PASSWORD,
    JWT_TTL_SECONDS: String(TTL), JWT_REFRESH_GRACE_SECONDS: '3600', RATE_LIMIT_MAX: '100000'
  });

  const config = require('../backend/src/config');
  const { migrate } = require('../backend/src/db/migrate');
  const { ensureAdmin } = require('../backend/src/services/auth');
  const { seed } = require('../database/seeds/seed');
  const { createServer } = require('../backend/src/server');
  migrate(); ensureAdmin(); seed({ skipMigrate: true, skipAdmin: true });
  const server = createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port;

  /* ============ 场景 A：正常浏览器（localStorage 可用） ============ */
  console.log('[A] 正常浏览器');
  const stA = storageOk();
  const A = makeEnv({ base, storage: stA });
  ok('A0 存储层为 localStorage', A.API.storageMode() === 'localStorage', A.API.storageMode());

  A.counters.modalOpens = 0;
  const noToken = await A.API.bootstrap();
  ok('A1 未登录时后台拉取静默失败', noToken === null);
  ok('A2 未登录时后台拉取不弹登录框', A.counters.modalOpens === 0, A.counters.modalOpens);

  // 主动登录（用户点了登录）→ 应弹一次框
  const loginP = A.API.login({ expired: false });
  await new Promise(r => setTimeout(r, 20));
  ok('A3 主动登录会弹登录框', A.counters.modalOpens === 1, A.counters.modalOpens);
  A.counters.lastLayout && A.counters.lastLayout.id === 'pkbLogin';
  await A.submitLogin();
  const loggedIn = await loginP;
  ok('A4 登录成功', loggedIn === true, loggedIn);
  ok('A5 登录后令牌写入 localStorage', Boolean(stA.localStorage._dump()['pkb.token']));
  ok('A6 登录后状态为已认证', A.API.status().authenticated === true);

  // 关键：注册后立刻请求 /state，服务端必须认得出人（actor 不是 anonymous）
  const s1 = await A.API.request('/state');
  ok('A7 登录后请求 /state 成功（带上了令牌）', Array.isArray(s1.students));

  /* ============ 场景 B：令牌过期但在宽限期内 ============ */
  console.log('[B] 令牌过期但仍在宽限期');
  await new Promise(r => setTimeout(r, (TTL + 1) * 1000));
  A.counters.modalOpens = 0;
  const s2 = await A.API.bootstrap();
  ok('B1 过期后后台同步静默续期成功', s2 !== null && Array.isArray(s2.students));
  ok('B2 静默续期全程不弹登录框（原来的主要毛病）', A.counters.modalOpens === 0, A.counters.modalOpens);
  ok('B3 续期后仍为已连接', A.API.status().online === true);
  ok('B4 续期后未标记会话过期', A.API.status().sessionExpired === false);
  ok('B5 续期后剩余时间充足', A.API.status().minutesLeft > 0, A.API.status().minutesLeft);

  /* ============ 场景 C：宽限期也过了 ============ */
  console.log('[C] 超出宽限期');
  const { signToken } = require('../backend/src/utils/crypto');
  const conn = require('../backend/src/db/connection');
  const u = conn.get("SELECT * FROM users WHERE username = 'admin' AND deleted_at IS NULL");
  const deadToken = signToken({ sub: u.id, username: u.username, role: u.role }, -(config.jwtRefreshGraceSeconds + 120));
  const stC = storageOk({ 'pkb.token': deadToken, 'pkb.token.exp': String(Date.now() - 1000) });
  const C = makeEnv({ base, storage: stC });

  C.counters.modalOpens = 0;
  const dead = await C.API.bootstrap();
  ok('C1 过期过久：后台拉取静默失败', dead === null);
  ok('C2 过期过久：仍然不弹登录框（核心修复）', C.counters.modalOpens === 0, C.counters.modalOpens);
  ok('C3 过期过久：标记 sessionExpired', C.API.status().sessionExpired === true);
  ok('C4 过期过久：界面据此显示顶部提示条', C.API.status().authenticated === true && C.API.status().sessionExpired === true);

  C.counters.modalOpens = 0;
  C.API.syncNow({ students: [], plans: [], sessions: [], assessments: [], defaults: {}, prefs: {}, params: {}, thresholds: {} });
  await new Promise(r => setTimeout(r, 900));
  ok('C5 过期过久：450ms 防抖同步也不弹框', C.counters.modalOpens === 0, C.counters.modalOpens);

  C.counters.modalOpens = 0;
  C.counters.modalOpens = 0;
  let threw = false;
  const interactive = C.API.request('/state', { interactive: true }).catch(() => { threw = true; });
  await new Promise(r => setTimeout(r, 120));
  ok('C6 教练主动操作时才弹登录框', C.counters.modalOpens === 1, C.counters.modalOpens);
  C.clickOffline();                       // 点「离线继续」
  await interactive;
  ok('C7 弹框后请求如实失败（不假装成功）', threw === true);
  C.counters.modalOpens = 0;
  try { await C.API.request('/state', { interactive: true }); } catch (_) { threw = true; }
  ok('C8 点过「离线继续」后，前台操作不再追着弹框', C.counters.modalOpens === 0, C.counters.modalOpens);

  /* ============ 场景 D：沙箱 iframe，存储全部抛 SecurityError ============ */
  console.log('[D] 沙箱 iframe（存储被禁）');
  const D = makeEnv({ base, storage: storageBlocked() });
  ok('D0 api.js 没有因存储异常而崩溃', typeof D.API.request === 'function');
  ok('D1 自动降级为内存存储', D.API.storageMode() === 'memory', D.API.storageMode());
  D.counters.modalOpens = 0;
  const dLogin = D.API.login({ expired: false });
  await new Promise(r => setTimeout(r, 20));
  await D.submitLogin();
  ok('D2 存储被禁时仍能登录', (await dLogin) === true);
  const dState = await D.API.request('/state');
  ok('D3 登录后请求带上了令牌（不再匿名 401）', Array.isArray(dState.students));

  /* ============ 场景 E：登出 ============ */
  console.log('[E] 登出');
  A.API.logout();
  ok('E1 登出后 authenticated=false', A.API.status().authenticated === false);
  ok('E2 登出后令牌从存储清除', !stA.localStorage._dump()['pkb.token']);

  await new Promise(r => server.close(r));
  conn.closeDb();
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbFile + s); } catch (_) {} }
  void stC; void C.ctx;
  console.log(`[check:auth] pass=${pass} fail=${fail}`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => {
  console.error('RUNTIME FAIL:', e.message);
  console.error(e.stack.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
});
