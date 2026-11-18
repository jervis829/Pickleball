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

  let token = localStorage.getItem(TOKEN_KEY) || '';
  let revision = null;
  let online = false;
  let lastSync = '';
  let lastError = '';
  let syncing = false, queued = false, queuedState = null, timer = null;
  let loginPromise = null;

  const time = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const day = () => new Date().toISOString().slice(0, 10);
  const status = () => ({ online, lastSync, lastError, revision });
  const emit = () => document.dispatchEvent(new CustomEvent('pkb:sync', { detail: status() }));
  const toast = (m) => { if (typeof window.toast === 'function') window.toast(m); };

  function setToken(t) {
    token = t || '';
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  }

  async function raw(path, opts) {
    const headers = Object.assign({ 'content-type': 'application/json' }, opts.headers || {});
    if (token) headers.authorization = 'Bearer ' + token;
    let res;
    try { res = await fetch(BASE + path, Object.assign({}, opts, { headers })); }
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

  async function request(path, opts = {}, retried) {
    try { return await raw(path, opts); }
    catch (e) {
      if (e.status === 401 && !retried && path !== '/auth/login') {
        const ok = await promptLogin();
        if (ok) return request(path, opts, true);
      }
      throw e;
    }
  }

  /* ---------- 登录遮罩（仅数据服务需要鉴权时弹出） ---------- */
  function promptLogin() {
    if (loginPromise) return loginPromise;
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
        '<h2>登录教学管理平台</h2>' +
        '<p>学员、教案与追踪数据保存在本机 SQLite 数据库。登录后自动同步；未登录时可离线继续，但数据仅存本机浏览器。</p>' +
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
        online = false; lastError = '未登录 · 离线模式'; emit(); done(false);
      });
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        err.textContent = '';
        const username = form.elements.username.value.trim();
        const password = form.elements.password.value;
        try {
          const r = await request('/auth/login', {
            method: 'POST', body: JSON.stringify({ username, password })
          }, true);
          setToken(r.token);
          online = true; lastError = ''; emit();
          done(true);
        } catch (ex) { err.textContent = ex.message || '登录失败'; }
      });
      setTimeout(() => { const el = form.elements.password; if (el) el.focus(); }, 30);
    });
    return loginPromise;
  }

  /* ---------- 启动：从数据库拉取全量 state ---------- */
  async function bootstrap() {
    try {
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
      const d = await request('/export');
      download('匹克球教学管理平台-数据库备份-' + day() + '.json', d);
      toast('已导出数据库备份（含 revision）');
    } catch (e) {
      if (typeof window.exportData === 'function') { window.exportData(); toast('服务不可用，已导出本机缓存'); }
      else throw e;
    }
  }

  async function importAll(payload) {
    const r = await request('/import', { method: 'POST', body: JSON.stringify(payload || {}) });
    revision = r.revision; online = true; lastSync = time(); lastError = ''; emit();
    return r;
  }

  const changePassword = (old_password, new_password) =>
    request('/auth/change-password', {
      method: 'POST', body: JSON.stringify({ old_password, new_password })
    });

  const logout = () => {
    setToken(''); online = false; lastError = '已退出登录 · 离线模式'; emit();
  };

  window.PKB_API = {
    bootstrap, scheduleSync, status, exportAll, importAll,
    changePassword, logout, request, promptLogin,
    online: () => online,
    syncNow: (s) => flush(s)
  };
})();
