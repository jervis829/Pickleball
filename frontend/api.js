/* ============================================================
   匹克球教学管理平台 · 前端数据访问层（API 层）
   - 唯一数据写入口：后端 SQLite 数据库（/api/v1/state）
   - localStorage 仅作离线缓存与降级，不再是数据源
   - 双写策略：save() 立即写本地缓存 → 450ms 防抖推数据库
   - 乐观锁：revision 不匹配时返回 409，提示刷新，不静默覆盖
   ============================================================ */
(function () {
  'use strict';
  const BASE = '/api/v1';
  const TOKEN_KEY = 'pkb.token';

  const EXP_KEY = 'pkb.token.exp';

  /* ------------------------------------------------------------
     存储降级：某些嵌入环境（如 sandbox="allow-scripts" 的 iframe）
     访问 localStorage 会直接抛 SecurityError。原实现裸调
     localStorage.getItem 会让整个 IIFE 抛出，令牌读不到、也存不住，
     结果是「刚登录完，下一个请求又是匿名」——表现为反复弹登录框。
     策略：localStorage → sessionStorage → 纯内存，逐级降级，永不抛错。
     ------------------------------------------------------------ */
  const memStore = Object.create(null);
  const pickStorage = (name) => {
    try {
      const s = window[name];
      if (!s) return null;
      const probe = '__pkb_probe__';
      s.setItem(probe, '1');
      s.removeItem(probe);
      return s;
    } catch (_) { return null; }
  };
  const LS = pickStorage('localStorage');
  const SS = pickStorage('sessionStorage');
  const storeName = LS ? 'localStorage' : (SS ? 'sessionStorage' : 'memory');
  const store = {
    get(k) {
      try { if (LS) return LS.getItem(k); } catch (_) {}
      try { if (SS) return SS.getItem(k); } catch (_) {}
      return k in memStore ? memStore[k] : null;
    },
    set(k, v) {
      memStore[k] = String(v);
      try { if (LS) { LS.setItem(k, v); return; } } catch (_) {}
      try { if (SS) SS.setItem(k, v); } catch (_) {}
    },
    del(k) {
      delete memStore[k];
      try { if (LS) LS.removeItem(k); } catch (_) {}
      try { if (SS) SS.removeItem(k); } catch (_) {}
    }
  };

  let token = store.get(TOKEN_KEY) || '';
  let tokenExp = Number(store.get(EXP_KEY)) || 0;   // 秒级时间戳
  let revision = null;
  let online = false;
  let lastSync = '';
  let lastError = '';
  let syncing = false, queued = false, queuedState = null, timer = null;
  let loginPromise = null;
  let refreshing = null;
  // 续期失败（宽限期也过了）时置位：此后不再自动弹登录框，改为顶部「会话已过期」提示条，
  // 由教练自己决定何时重新登录。这样后台同步不会在他上课中途把登录框顶到脸上。
  let sessionExpired = false;
  // 用户在登录框里点过「离线继续」：说明他此刻不想登录，之后前台操作也不再自动弹框，
  // 只保留顶部提示条上的「重新登录」按钮。再次主动登录成功后自动解除。
  let autoPromptDisabled = false;
  const refreshMarginMs = 5 * 60 * 1000;      // 剩余不足 5 分钟就提前续期
  const lapsedMs = () => (tokenExp ? tokenExp - Date.now() : 0);
  const hasToken = () => Boolean(token);

  const time = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const day = () => new Date().toISOString().slice(0, 10);
  const status = () => ({ online, lastSync, lastError, revision });
  const emit = () => document.dispatchEvent(new CustomEvent('pkb:sync', { detail: status() }));
  const toast = (m) => { if (typeof window.toast === 'function') window.toast(m); };

  function setToken(t, expiresInSeconds) {
    token = t || '';
    if (t) {
      store.set(TOKEN_KEY, t);
      if (expiresInSeconds) {
        tokenExp = Date.now() + Number(expiresInSeconds) * 1000;
        store.set(EXP_KEY, String(tokenExp));
      }
      sessionExpired = false;
    } else {
      tokenExp = 0;
      store.del(TOKEN_KEY);
      store.del(EXP_KEY);
    }
  }

  /* ---------- 静默续期：不打断教练操作 ---------- */
  async function refreshToken() {
    if (!token) return false;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        const r = await raw('/auth/refresh', { method: 'POST', body: '{}', skipAuthRetry: true });
        setToken(r.token, r.expires_in);
        online = true; lastError = ''; sessionExpired = false; emit();
        return true;
      } catch (e) {
        // 宽限期也过了：不弹窗，标记为过期，交给顶部提示条
        if (e.status === 401) {
          sessionExpired = true;
          online = false;
          lastError = '登录已过期（数据仍在本机，重新登录后即可继续同步）';
          emit();
        }
        return false;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  /** 主动检查：页面可见 / 定时器 / 请求成功后调用 */
  function ensureFreshToken() {
    if (!token) return Promise.resolve(false);
    const left = lapsedMs();
    if (left > refreshMarginMs) return Promise.resolve(true);
    return refreshToken();
  }

  async function raw(path, opts) {
    const headers = Object.assign({ 'content-type': 'application/json' }, opts.headers || {});
    if (token && !opts.anonymous) {
      headers.authorization = 'Bearer ' + token;
      headers['x-pkb-auth'] = 'Bearer ' + token;
    }
    let res;
    try { res = await fetch(BASE + path, Object.assign({ credentials: 'same-origin' }, opts, { headers })); }
    catch (_) {
      const e = new Error('无法连接数据服务，请先运行 npm start');
      e.offline = true; throw e;
    }
    let payload = null;
    try { payload = await res.json(); } catch (_) { /* 204 等无响应体 */ }
    if (!res.ok) {
      const e = new Error((payload && payload.error && payload.error.message) || ('HTTP ' + res.status));
      e.status = res.status;
      e.code = payload && payload.error && payload.error.code;
      e.payload = payload;
      throw e;
    }
    return payload && payload.data !== undefined ? payload.data : payload;
  }

  /**
   * 401 处理策略（这是「登录框反复弹出」的根因修复）：
   *   1. 先静默续期一次——绝大多数情况是令牌到期，续期即可，用户无感；
   *   2. 续期也失败 → 不立刻弹窗。标 sessionExpired，抛错由调用方降级处理；
   *   3. 只有「前台主动操作」（interactive: true，比如用户点了按钮）才弹登录框，
   *      后台 450ms 防抖同步、启动拉取、页面可见性检查一律静默失败。
   */
  async function request(path, opts = {}, retried) {
    const interactive = opts.interactive === true;
    try { return await raw(path, opts); }
    catch (e) {
      if (e.status !== 401) throw e;
      if (path === '/auth/login' || path === '/auth/refresh') throw e;
      if (!retried) {
        const renewed = await refreshToken();
        if (renewed) return request(path, opts, true);
      }
      // 续期失败：只有前台交互且本次尚未重新登录过才弹框，防止异常代理下死循环弹窗
      if (!retried && interactive && !autoPromptDisabled) {
        const ok = await promptLogin({ expired: true });
        if (ok) return request(path, Object.assign({}, opts, { interactive: true }), true);
      }
      e.sessionExpired = true;
      throw e;
    }
  }

  /* ---------- 登录遮罩（仅数据服务需要鉴权时弹出） ---------- */
  function promptLogin(info) {
    if (loginPromise) return loginPromise;
    const expired = Boolean(info && info.expired);
    loginPromise = new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.id = 'pkbLogin';
      wrap.innerHTML =
        '<style>' +
        '#pkbLogin{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(5,6,7,.8);backdrop-filter:blur(6px);font-family:inherit}' +
        '#pkbLogin .card{width:min(430px,92vw);background:#151619;border:1px solid rgba(255,255,255,.11);border-radius:14px;padding:28px;box-shadow:0 24px 70px rgba(0,0,0,.55);color:#F2F3F1}' +
        '#pkbLogin .kicker{font:500 11px/1.4 "IBM Plex Mono",monospace;letter-spacing:.12em;color:#D8F35A;text-transform:uppercase}' +
        '#pkbLogin h2{font-size:20px;margin:10px 0 6px;font-weight:600}' +
        '#pkbLogin p{font-size:12px;line-height:1.7;color:#9CA3A8;margin:0 0 18px}' +
        '#pkbLogin label{display:block;font-size:12px;color:#9CA3A8;margin-bottom:12px}' +
        '#pkbLogin input{display:block;width:100%;margin-top:6px;padding:10px 12px;background:#0B0C0D;border:1px solid rgba(255,255,255,.13);border-radius:8px;color:#F2F3F1;font-size:14px;outline:none}' +
        '#pkbLogin input:focus{border-color:#D8F35A}' +
        '#pkbLogin .err{min-height:18px;font-size:12px;color:#E4786A;margin:2px 0 8px}' +
        '#pkbLogin .actions{display:flex;gap:8px;margin-top:6px}' +
        '#pkbLogin button{flex:1;padding:10px;border-radius:8px;font-size:13px;cursor:pointer;border:1px solid rgba(255,255,255,.13);background:transparent;color:#F2F3F1}' +
        '#pkbLogin button.primary{background:#D8F35A;color:#11130A;border-color:#D8F35A;font-weight:600}' +
        '#pkbLogin .hint{margin-top:16px;font-size:11px;color:#6B7280;margin-bottom:0}' +
        '</style>' +
        '<form class="card" autocomplete="on">' +
        '<div class="kicker">PICKLEBALL ACADEMY / DATA SERVICE</div>' +
        '<h2>' + (expired ? '会话已过期，请重新登录' : '登录教学管理平台') + '</h2>' +
        '<p>' + (expired
          ? '登录有效期已过（默认 12 小时，合盖休眠过久也会发生）。本机数据没有丢，重新登录后会自动继续同步。'
          : '学员、教案与追踪数据保存在本机 SQLite 数据库。登录后自动同步；未登录时可离线继续，但数据仅存本机浏览器。') + '</p>' +
        '<label>账号<input name="username" value="admin" autocomplete="username"></label>' +
        '<label>密码<input name="password" type="password" autocomplete="current-password" placeholder="首次密码见 data/initial-admin.txt"></label>' +
        '<div class="err"></div>' +
        '<div class="actions"><button type="button" class="ghost">离线继续</button><button type="submit" class="primary">登录并同步</button></div>' +
        '<p class="hint">首次启动会随机生成管理员密码，见服务端 data/initial-admin.txt；登录后请立即修改并删除该文件。</p>' +
        '</form>';
      document.body.appendChild(wrap);
      const form = wrap.querySelector('form');
      const err = wrap.querySelector('.err');
      const done = (v) => { wrap.remove(); loginPromise = null; resolve(v); };

      wrap.querySelector('.ghost').addEventListener('click', () => {
        online = false; lastError = '未登录 · 离线模式';
        autoPromptDisabled = true;   // 用户已明确选择离线，别再拿登录框烦他
        emit(); done(false);
      });
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        err.textContent = '';
        const username = form.elements.username.value.trim();
        const password = form.elements.password.value;
        try {
          const r = await request('/auth/login', {
            method: 'POST', body: JSON.stringify({ username, password }), anonymous: true, interactive: true
          }, true);
          setToken(r.token, r.expires_in);
          online = true; lastError = ''; sessionExpired = false;
          autoPromptDisabled = false;
          emit(); done(true);
        } catch (ex) { err.textContent = ex.message || '登录失败'; }
      });
      setTimeout(() => { const el = form.elements.password; if (el) el.focus(); }, 30);
    });
    return loginPromise;
  }

  /* ---------- 启动：从数据库拉取全量 state ---------- */
  async function bootstrap() {
    try {
      await ensureFreshToken();   // 后台续期：能续就静默续，不弹窗
      const s = await request('/state');
      revision = s.revision;
      online = true; lastError = ''; emit();
      return s;
    } catch (e) {
      online = false; lastError = e.message; emit();
      return null;
    }
  }

  /* ---------- 写入：防抖 + 乐观锁 ---------- */
  function snapshot(s) {
    return {
      students: s.students || [], plans: s.plans || [],
      sessions: s.sessions || [], assessments: s.assessments || [],
      demo: Boolean(s.demo), thresholds: s.thresholds || {},
      defaults: s.defaults || {}, prefs: s.prefs || {}, params: s.params || {}
    };
  }

  async function flush(s) {
    if (syncing) { queued = true; queuedState = s; return; }
    syncing = true;
    try {
      const r = await request('/state', {
        method: 'PUT', body: JSON.stringify({ state: snapshot(s), revision })
      });
      revision = r.revision;
      online = true; lastError = ''; lastSync = time(); emit();
    } catch (e) {
      if (e.status === 409) {
        online = false; lastError = '同步冲突，请刷新页面';
        toast('数据已在其他设备更新，请刷新页面后再编辑');
      } else {
        online = false; lastError = e.message;
      }
      emit();
    } finally {
      syncing = false;
      if (queued) { queued = false; const q = queuedState; queuedState = null; flush(q); }
    }
  }

  function scheduleSync(s) {
    if (!token && !online) return; // 明确选择离线时不推数据库
    clearTimeout(timer);
    timer = setTimeout(() => flush(s), 450);
  }

  /* ---------- 备份 / 导入 / 账号 ---------- */
  function download(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function exportAll() {
    try {
      const d = await request('/export', { interactive: true });
      download('匹克球教学管理平台-数据库备份-' + day() + '.json', d);
      toast('已导出数据库备份（含 revision）');
    } catch (e) {
      if (typeof window.exportData === 'function') { window.exportData(); toast('服务不可用，已导出本机缓存'); }
      else throw e;
    }
  }

  async function importAll(payload) {
    const r = await request('/import', { method: 'POST', body: JSON.stringify(payload || {}), interactive: true });
    revision = r.revision; online = true; lastSync = time(); lastError = ''; emit();
    return r;
  }

  const changePassword = (old_password, new_password) =>
    request('/auth/change-password', {
      method: 'POST', body: JSON.stringify({ old_password, new_password })
    });

  const logout = () => {
    setToken(''); online = false; lastError = '已退出登录 · 离线模式'; emit();
    if (typeof window !== 'undefined' && window.location && /^https?:/.test(String(window.location.protocol || ''))) {
      try { fetch(BASE + '/auth/logout', { method: 'POST', credentials: 'same-origin', keepalive: true }).catch(() => {}); } catch (_) {}
    }
  };

  /* ---------- 页面可见 / 定时器：提前续期，避免在操作时才发现过期 ---------- */
  if (typeof document !== 'undefined' && document.addEventListener) {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') ensureFreshToken();
    });
  }
  const keepAlive = setInterval(() => {
    if (token) ensureFreshToken();
  }, 10 * 60 * 1000);   // 每 10 分钟检查一次；令牌 12 小时，正常营业日内只续几次
  if (keepAlive.unref) keepAlive.unref();

  const statusFull = () => Object.assign(status(), {
    authenticated: Boolean(token),
    sessionExpired,
    expiresAt: tokenExp || null,
    minutesLeft: tokenExp ? Math.max(0, Math.round((tokenExp - Date.now()) / 60000)) : null
  });

  window.PKB_API = {
    bootstrap, scheduleSync, status: statusFull, exportAll, importAll,
    changePassword, logout, request, promptLogin,
    online: () => online,
    syncNow: (s) => flush(s),
    ensureFreshToken,
    refreshToken,
    sessionExpired: () => sessionExpired,
    // 令牌落在哪一层存储：localStorage / sessionStorage / memory
    // memory 表示当前页面刷新后会掉登录（第三方 iframe 里可能发生），
    // 界面据此提示「不要刷新页面」，并把 12 小时有效期如实告知。
    storageMode: () => storeName,
    // 前台主动登录（顶部「重新登录」按钮用）：会弹登录框
    login: (info) => promptLogin(info || { expired: true })
  };
})();
