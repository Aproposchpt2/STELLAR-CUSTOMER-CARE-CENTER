// Shared client code for the Simulation Testing admin pages (/admin/testing and
// /admin/testing/script/<slug>). Sign-in is the Supabase email-code login used by
// /manager (shouldCreateUser:false). The API checks the token against ops_admins.
(function () {
  const SB_URL = 'https://vqrqyanqsiqzsmlhytaz.supabase.co';
  const SB_KEY = 'sb_publishable_S0l5GIDgAiECvhL-03FUkA_r8kjUjr9';
  const sb = window.supabase.createClient(SB_URL, SB_KEY, { auth: { flowType: 'pkce' } });
  let session = null;
  let ready = null;

  const SITE = /(^|\.)pma\./.test(location.hostname) ? 'PROPERTY MANAGEMENT ASSISTANT' : /(^|\.)ccc\./.test(location.hostname) ? 'CUSTOMER CARE CENTER' : 'SPECIALIST';

  const $ = (id) => document.getElementById(id);
  function show(signedIn) {
    $('login-screen').style.display = signedIn ? 'none' : '';
    $('app').style.display = signedIn ? '' : 'none';
    if (signedIn && $('user-email')) $('user-email').textContent = session?.user?.email || '';
  }

  async function boot(opts) {
    ready = opts.onReady;
    const rib = $('ribbon-site'); if (rib) rib.textContent = `${SITE} · SIMULATION TESTING`;
    $('send-code').addEventListener('click', sendCode);
    $('verify-code').addEventListener('click', verifyCode);
    $('login-email').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendCode(); });
    $('login-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') verifyCode(); });
    $('sign-out').addEventListener('click', signOut);
    const { data } = await sb.auth.getSession();
    session = data.session;
    show(!!session);
    if (session) ready();
    sb.auth.onAuthStateChange((evt, s) => {
      const was = !!session; session = s;
      if (evt === 'SIGNED_OUT') show(false);
      else if (s && !was) { show(true); ready(); }
    });
  }

  async function sendCode() {
    const email = $('login-email').value.trim(); const msg = $('login-msg');
    if (!email) { msg.textContent = 'Enter your email address.'; return; }
    msg.textContent = 'Sending…';
    const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: location.origin + '/admin/testing' } });
    if (error) { msg.textContent = 'Could not send a code: ' + error.message; return; }
    msg.textContent = 'Check your email and enter the code below.';
    $('code-step').style.display = ''; $('login-code').focus();
  }

  async function verifyCode() {
    const email = $('login-email').value.trim(); const token = $('login-code').value.replace(/\s/g, ''); const msg = $('login-msg');
    if (!email || !/^\d{6,10}$/.test(token)) { msg.textContent = 'Enter your email and the code from the email.'; return; }
    msg.textContent = 'Verifying…';
    const { data, error } = await sb.auth.verifyOtp({ email, token, type: 'email' });
    if (error) { msg.textContent = 'Could not sign in: ' + error.message; return; }
    const was = !!session; session = data.session;
    if (!was) { show(true); ready(); }
  }

  async function signOut() { await sb.auth.signOut(); session = null; show(false); }

  // Throws Error(message) on any failure; callers show it inline.
  // Last 50 failed API calls on this page, included in every JSON report.
  const errorLog = [];
  function logError(entry) { errorLog.push({ at: new Date().toISOString(), ...entry }); if (errorLog.length > 50) errorLog.shift(); }

  async function api(path, { method = 'GET', body } = {}) {
    const { data } = await sb.auth.getSession();
    session = data.session || session;
    const t0 = performance.now();
    let res;
    try {
      res = await fetch(path, {
        method,
        headers: { 'content-type': 'application/json', Authorization: 'Bearer ' + (session?.access_token || '') },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      logError({ method, path, request_body: body || null, status: 0, error: 'Network error: ' + (e?.message || e) });
      throw new Error('Network error. Check your connection.');
    }
    let d = {};
    try { d = await res.json(); } catch { /* empty */ }
    if (!res.ok) logError({ method, path, request_body: body || null, status: res.status, error: d.error || null, response: d, ms: Math.round(performance.now() - t0) });
    if (res.status === 401) { await signOut(); $('login-msg').textContent = d.error || 'Sign in again.'; throw new Error(d.error || 'Sign in required'); }
    if (!res.ok) throw new Error(d.error || `Request failed (HTTP ${res.status})`);
    return d;
  }

  // ---------- JSON reports ----------
  function report(kind, payload) {
    return {
      report: kind,
      generated_at: new Date().toISOString(),
      generated_by: session?.user?.email || null,
      site: location.host,
      page: location.pathname + location.search,
      user_agent: navigator.userAgent,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      ...payload,
      client_errors: errorLog.slice(),
    };
  }
  function download(name, obj) {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  // Agent run detail as a reviewer reads it: each criterion with its own verdict.
  function explainRun(r) {
    if (!r) return null;
    return { ...r, outcome: r.status, open: isOpen(r), duration_human: dur(r.duration_ms) || null };
  }

  // ---------- formatting ----------
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  function ago(iso) {
    if (!iso) return '';
    const s = (Date.now() - new Date(iso)) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }
  function dur(ms) {
    if (ms == null) return '';
    if (ms < 1000) return ms + ' ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + ' s';
    return Math.floor(ms / 60000) + 'm ' + Math.round((ms % 60000) / 1000) + 's';
  }
  function fmtDate(iso) {
    if (!iso) return '—';
    try { return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' }); }
    catch { return iso; }
  }
  const statusOf = (r) => (r ? String(r.status || 'never') : 'never');
  const isOpen = (r) => !!r && (r.status === 'running' || r.status === 'queued');
  function trigger(t) {
    if (!t) return '—';
    if (t.startsWith('admin:')) return t.slice(6);
    return t === 'daily' ? 'Daily schedule' : t === 'manual' ? 'Manual' : t;
  }

  function textOf(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    return v.message || v.text || v.prompt || v.condition || v.description || v.name || JSON.stringify(v);
  }

  function agentSpec(s) {
    let conds = s.success_conditions;
    if (typeof conds === 'string') { try { conds = JSON.parse(conds); } catch { conds = [conds]; } }
    if (conds && !Array.isArray(conds)) conds = typeof conds === 'object' ? Object.entries(conds).map(([k, v]) => (typeof v === 'string' ? `${k}: ${v}` : v)) : [conds];
    const list = (conds || []).map(textOf).filter(Boolean);
    return `
      <div class="field-row"><span class="field-label">Scenario</span><span class="field-val pre">${esc(s.scenario || '—')}</span></div>
      <div class="field-row"><span class="field-label">Success conditions</span>${list.length ? `<ul class="conds">${list.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>` : '<span class="field-val muted">—</span>'}</div>`;
  }

  function criteriaList(r) {
    const crit = r.detail?.criteria;
    if (!Array.isArray(crit) || !crit.length) return '';
    const runOk = r.status === 'pass';
    return `<div class="field-row"><span class="field-label">Criteria</span><ul class="criteria">${crit.map((c) => {
      // A line with its own result gets ✓/✕. Plain lines get ✓ on a passed run, else a neutral mark.
      let ok = runOk ? true : null;
      if (c && typeof c === 'object') {
        const v = c.result ?? c.passed ?? c.status;
        if (v != null) ok = v === true || /^(pass|passed|success|true)$/i.test(String(v));
      }
      const cls = ok === true ? 'ok' : ok === false ? 'bad' : 'info';
      return `<li class="${cls}"><span class="mark">${ok === true ? '✓' : ok === false ? '✕' : '•'}</span><span>${esc(textOf(c))}</span></li>`;
    }).join('')}</ul></div>`;
  }

  function stressDetail(r) {
    const d = r.detail;
    if (!d || d.kind !== 'stress') return '';
    const kv = (k, v) => `<div class="kv"><span>${esc(k)}</span><span>${esc(v)}</span></div>`;
    const dbRows = Object.entries(d.db_check || {}).map(([k, v]) => kv(k.replace(/_/g, ' '), v)).join('');
    return `<div class="field-row"><span class="field-label">Load</span><div class="kv-grid">
        ${kv('Concurrent calls', d.concurrent_calls)}${kv('Requests', d.requests)}${kv('Errors', d.errors)}${kv('Total time', dur(d.wall_ms))}
        ${kv('Typical (p50)', dur(d.p50_ms))}${kv('Slow (p95)', dur(d.p95_ms))}${kv('Slowest', dur(d.max_ms))}</div></div>
      ${dbRows ? `<div class="field-row"><span class="field-label">Database check</span><div class="kv-grid">${dbRows}</div></div>` : ''}
      ${(d.first_errors || []).length ? `<div class="field-row"><span class="field-label">First errors</span><ul class="conds">${d.first_errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul></div>` : ''}
      ${(d.cleanup_errors || []).length ? `<div class="err-box">Cleanup errors: ${esc(d.cleanup_errors.join('; '))}</div>` : ''}`;
  }

  function runDetail(r, s) {
    const extra = r.detail && s?.layer === 'backend' && r.detail.check ? `<div class="kv"><span>Check</span><span>${esc(r.detail.check)}</span></div>` : '';
    return `
      <div class="kv-grid">
        <div class="kv"><span>Started</span><span>${esc(fmtDate(r.started_at))}</span></div>
        <div class="kv"><span>Finished</span><span>${isOpen(r) ? '—' : esc(fmtDate(r.finished_at))}</span></div>
        <div class="kv"><span>Duration</span><span>${isOpen(r) ? '—' : esc(dur(r.duration_ms) || '—')}</span></div>
        <div class="kv"><span>Triggered by</span><span>${esc(trigger(r.triggered_by))}</span></div>
        ${extra}
      </div>
      ${r.summary ? `<div class="field-row"><span class="field-label">Summary</span><span class="field-val pre">${esc(r.summary)}</span></div>` : ''}
      ${stressDetail(r)}
      ${criteriaList(r)}
      ${r.external_id ? `<p class="muted mono small">ElevenLabs invocation ${esc(r.external_id)}${r.external_run_id ? ` · run ${esc(r.external_run_id)}` : ''}</p>` : ''}`;
  }

  window.OpsAdmin = { boot, api, esc, ago, dur, fmtDate, statusOf, isOpen, trigger, agentSpec, runDetail, report, download, stamp, explainRun, errorLog };
})();
