// Shared engine for the Simulation Testing admin panel (identical file on the PMA,
// Specialist, Sales and Customer Care Center sites). Each site tests only its own product: siteProduct()
// comes from OPS_PRODUCT or, by default, the site's own domain. Reads the one script
// directory (ops_test_scripts), starts ElevenLabs agent tests, hands backend and
// stress runs to this site's own background functions, and settles open runs.
//
// Keys stay server-side: ELEVENLABS_API_KEY and SUPABASE_SERVICE_ROLE_KEY are
// Netlify env vars only.

import { createClient } from '@supabase/supabase-js';

export const PRODUCTS = ['support', 'sales', 'pma', 'ccc'];

// This site's product. OPS_PRODUCT wins; otherwise the site's domain decides.
const HOST_PRODUCT = [[/(^|\.)pma\./, 'pma'], [/(^|\.)sales\./, 'sales'], [/(^|\.)specialist\./, 'support'], [/(^|\.)ccc\./, 'ccc']];
export function siteProduct() {
  const forced = String(process.env.OPS_PRODUCT || '').trim().toLowerCase();
  if (PRODUCTS.includes(forced)) return forced;
  const host = String(process.env.URL || '').replace(/^https?:\/\//, '').toLowerCase();
  const hit = HOST_PRODUCT.find(([re]) => re.test(host));
  if (!hit) throw new Error(`Cannot tell which product this site is (URL=${host || 'unset'}); set OPS_PRODUCT`);
  return hit[1];
}
const siteBase = () => String(process.env.URL || '').replace(/\/+$/, '');
const isStressKey = (k) => /\.stress$/.test(String(k || ''));
const EL_BASE = 'https://api.elevenlabs.io/v1/convai';
const AGENT_TIMEOUT_MS = 10 * 60 * 1000;   // agent run still open after 10 min -> error
const BACKEND_TIMEOUT_MS = 16 * 60 * 1000; // background budget is 15 min
const BACKEND_COOLDOWN_MS = 30 * 1000;
const HTTP_TIMEOUT_MS = 12000;
const OPEN = ['queued', 'running'];

let _db = null;
export function db() {
  if (_db) return _db;
  // The project URL is public; a malformed or bare-ID env value falls back to it.
  const clean = (v) => String(v || '').trim().replace(/^["']|["']$/g, '');
  const raw = clean(process.env.SUPABASE_URL).replace(/\/+$/, '');
  const url = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(raw) ? raw
    : /^[a-z0-9]{20}$/i.test(raw) ? `https://${raw}.supabase.co` : 'https://vqrqyanqsiqzsmlhytaz.supabase.co';
  const key = clean(process.env.SUPABASE_SERVICE_ROLE_KEY);
  if (!key) throw new Error('SUPABASE_NOT_CONFIGURED');
  _db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return _db;
}

async function fetchJson(url, { method = 'GET', headers = {}, body } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, ok: res.ok, json, text };
  } finally {
    clearTimeout(timer);
  }
}

function elHeaders() {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error('ELEVENLABS_API_KEY is not set on this site');
  return { 'xi-api-key': key };
}

function elError(r) {
  const d = r.json?.detail;
  const msg = typeof d === 'string' ? d : d?.message || r.text?.slice(0, 200);
  return `ElevenLabs HTTP ${r.status}${msg ? `: ${msg}` : ''}`;
}

const runId = (tr) => tr?.test_run_id || tr?.id || null;
const clip = (s, n) => (s == null ? null : String(s).slice(0, n));

// ---------- Script directory ----------

export async function listScripts() {
  const { data, error } = await db().from('ops_test_scripts').select('*');
  if (error) throw new Error(`ops_test_scripts: ${error.message}`);
  const order = (p) => { const i = PRODUCTS.indexOf(p); return i < 0 ? 99 : i; };
  return (data || []).sort((a, b) => order(a.product) - order(b.product)
    || (a.sort_order ?? 0) - (b.sort_order ?? 0) || String(a.name).localeCompare(String(b.name)));
}

export async function getScript(slug) {
  const { data, error } = await db().from('ops_test_scripts').select('*').eq('slug', slug).maybeSingle();
  if (error) throw new Error(`ops_test_scripts: ${error.message}`);
  return data;
}

// Latest run per script: one wide query, then single-row lookups for any script
// whose last run is older than that window.
export async function latestRuns(scriptIds) {
  const latest = {};
  if (!scriptIds.length) return latest;
  const { data, error } = await db().from('ops_test_runs').select('*')
    .in('script_id', scriptIds).order('started_at', { ascending: false }).limit(1000);
  if (error) throw new Error(`ops_test_runs: ${error.message}`);
  for (const r of data || []) if (!latest[r.script_id]) latest[r.script_id] = r;
  const missing = scriptIds.filter((id) => !latest[id]);
  if (missing.length && (data || []).length >= 1000) {
    await Promise.all(missing.map(async (id) => {
      const { data: one } = await db().from('ops_test_runs').select('*').eq('script_id', id)
        .order('started_at', { ascending: false }).limit(1);
      if (one?.[0]) latest[id] = one[0];
    }));
  }
  return latest;
}

export async function runHistory(scriptId, limit = 50) {
  const { data, error } = await db().from('ops_test_runs').select('*').eq('script_id', scriptId)
    .order('started_at', { ascending: false }).limit(limit);
  if (error) throw new Error(`ops_test_runs: ${error.message}`);
  return data || [];
}

// ---------- Settling open runs ----------

const _lastPoll = new Map(); // invocation id -> ms (per function instance)

function settleFromTestRun(row, tr) {
  const st = String(tr?.status || '').toLowerCase();
  if (st !== 'passed' && st !== 'failed') return null;
  const cr = tr.condition_result || {};
  const rationale = cr.rationale || {};
  const criteria = Array.isArray(rationale.messages) ? rationale.messages : [];
  const summary = rationale.summary
    || criteria.map((m) => (typeof m === 'string' ? m : m?.message || m?.text || '')).filter(Boolean).join(' ')
    || (st === 'passed' ? 'Test passed' : 'Test failed');
  const finished = new Date();
  return {
    status: st === 'passed' ? 'pass' : 'fail',
    summary: clip(summary, 2000),
    detail: { ...(row.detail || {}), criteria, result: cr.result || null, elevenlabs_status: st },
    finished_at: finished.toISOString(),
    duration_ms: row.started_at ? finished - new Date(row.started_at) : null,
  };
}

// Polls ElevenLabs for open agent runs (one call per invocation), closes timed-out
// runs, and closes backend rows the runner never finished. Never throws.
// Scheduled agent runs are often first checked long after they finish (the daily
// alert job runs 40 minutes after they start), so ElevenLabs is always asked for
// the result before an old run is marked as timed out.
export async function refreshOpenRuns({ scriptId, force = false } = {}) {
  const sb = db();
  let q = sb.from('ops_test_runs').select('*').in('status', OPEN).limit(200);
  if (scriptId) q = q.eq('script_id', scriptId);
  const { data: open, error } = await q;
  if (error || !open?.length) return;
  const now = Date.now();
  const ageOf = (row) => now - new Date(row.started_at || row.created_at || now).getTime();
  const byInvocation = {};
  const updates = [];

  for (const row of open) {
    if (row.external_id) {
      (byInvocation[row.external_id] ||= []).push(row);
    } else if (ageOf(row) > BACKEND_TIMEOUT_MS) {
      updates.push([row.id, { status: 'error', summary: 'Timed out: the backend runner never reported a result', finished_at: new Date().toISOString(), duration_ms: ageOf(row) }]);
    }
  }

  const timeOut = (row, why) => {
    const age = ageOf(row);
    if (age > AGENT_TIMEOUT_MS) updates.push([row.id, { status: 'error', summary: `Timed out: ${why} after ${Math.round(age / 60000)} minutes`, finished_at: new Date().toISOString(), duration_ms: age }]);
  };

  await Promise.all(Object.entries(byInvocation).map(async ([inv, rows]) => {
    const overdue = rows.some((row) => ageOf(row) > AGENT_TIMEOUT_MS);
    if (!force && !overdue && now - (_lastPoll.get(inv) || 0) < 3500) return;
    _lastPoll.set(inv, now);
    try {
      const r = await fetchJson(`${EL_BASE}/test-invocations/${encodeURIComponent(inv)}`, { headers: elHeaders() });
      if (!r.ok) {
        if (r.status === 404) for (const row of rows) updates.push([row.id, { status: 'error', summary: 'ElevenLabs no longer has this test invocation', finished_at: new Date().toISOString() }]);
        else for (const row of rows) timeOut(row, `ElevenLabs returned HTTP ${r.status} when asked for the result`);
        return;
      }
      const testRuns = r.json?.test_runs || [];
      for (const row of rows) {
        const tr = testRuns.find((t) => runId(t) === row.external_run_id)
          || testRuns.find((t) => t.test_id === row.detail?.test_id);
        const patch = settleFromTestRun(row, tr);
        if (patch) updates.push([row.id, patch]);
        else timeOut(row, `ElevenLabs still reports this test as ${String(tr?.status || 'missing').toLowerCase()}`);
      }
    } catch {
      for (const row of rows) timeOut(row, 'ElevenLabs could not be reached for the result');
    }
  }));

  await Promise.all(updates.map(([id, patch]) => sb.from('ops_test_runs').update(patch).eq('id', id).in('status', OPEN)));
}

// ---------- Starting runs ----------

async function openRunScriptIds(scriptIds) {
  if (!scriptIds.length) return new Set();
  const { data } = await db().from('ops_test_runs').select('script_id').in('script_id', scriptIds).in('status', OPEN);
  return new Set((data || []).map((r) => r.script_id));
}

// Starts agent scripts. Groups tests per agent so each agent gets one invocation.
// Returns { started: [run rows], skipped: [{slug, reason}], errors: [{slug, error}] }.
export async function startAgentRuns(scripts, triggeredBy) {
  const out = { started: [], skipped: [], errors: [] };
  const busy = await openRunScriptIds(scripts.map((s) => s.id));
  const byAgent = {};
  for (const s of scripts) {
    if (busy.has(s.id)) { out.skipped.push({ slug: s.slug, reason: 'already running' }); continue; }
    if (!s.agent_id || !s.elevenlabs_test_id) { out.errors.push({ slug: s.slug, error: 'Script has no agent_id or elevenlabs_test_id' }); continue; }
    (byAgent[s.agent_id] ||= []).push(s);
  }

  await Promise.all(Object.entries(byAgent).map(async ([agentId, group]) => {
    const fail = (error) => group.forEach((s) => out.errors.push({ slug: s.slug, error }));
    let r;
    try {
      r = await fetchJson(`${EL_BASE}/agents/${encodeURIComponent(agentId)}/run-tests`, {
        method: 'POST',
        headers: elHeaders(),
        body: { tests: group.map((s) => ({ test_id: s.elevenlabs_test_id })) },
      });
    } catch (err) { return fail(err?.name === 'AbortError' ? 'ElevenLabs timed out' : err.message); }
    if (!r.ok || !r.json?.id) return fail(elError(r));

    const startedAt = new Date().toISOString();
    const testRuns = r.json.test_runs || [];
    const rows = group.map((s) => {
      const tr = testRuns.find((t) => t.test_id === s.elevenlabs_test_id);
      return {
        script_id: s.id,
        status: 'running',
        external_id: r.json.id,
        external_run_id: runId(tr),
        triggered_by: clip(triggeredBy, 120),
        started_at: startedAt,
        summary: 'Running in ElevenLabs',
        detail: { test_id: s.elevenlabs_test_id, agent_id: agentId },
      };
    });
    const { data, error } = await db().from('ops_test_runs').insert(rows).select('*');
    if (error) return fail(`Started in ElevenLabs but could not record the run: ${error.message}`);
    out.started.push(...(data || []));
  }));
  return out;
}

// Hands one product's backend group to the specialist runner (setup and cleanup
// stay paired). Returns { state: 'queued'|'cooldown'|'running'|'error', message }.
// Hands this site's backend group to its own background runner (setup and cleanup stay
// paired). Returns { state: 'queued'|'cooldown'|'running'|'error', message }.
export async function startBackendGroup(product, triggeredBy) {
  if (product !== siteProduct()) return { state: 'error', message: `This site only runs ${siteProduct()} checks.` };
  const sb = db();
  const { data: rows } = await sb.from('ops_test_scripts').select('id, check_key').eq('layer', 'backend').eq('product', product);
  const ids = (rows || []).filter((r) => !isStressKey(r.check_key)).map((r) => r.id);
  if (!ids.length) return { state: 'none', message: 'No backend scripts' };
  const since = new Date(Date.now() - BACKEND_COOLDOWN_MS).toISOString();
  const { data: recent } = await sb.from('ops_test_runs').select('id').in('script_id', ids).gte('started_at', since).limit(1);
  if (recent?.length) return { state: 'cooldown', message: 'Backend checks just ran. Try again shortly.' };
  const busy = await openRunScriptIds(ids);
  if (busy.size) return { state: 'running', message: 'The backend checks are already running.' };
  return kick('ops-run-background', { trigger: clip(triggeredBy, 100) }, 'Running all backend checks (setup and cleanup stay paired).');
}

// Starts this site's stress test (background function, on demand only).
export async function startStress(triggeredBy) {
  const product = siteProduct();
  const sb = db();
  const { data: script } = await sb.from('ops_test_scripts').select('id').eq('product', product).eq('check_key', `${product}.stress`).maybeSingle();
  if (!script) return { state: 'error', message: 'No stress test script for this site.' };
  const busy = await openRunScriptIds([script.id]);
  if (busy.size) return { state: 'running', message: 'A stress test is already running.' };
  const since = new Date(Date.now() - 120 * 1000).toISOString();
  const { data: recent } = await sb.from('ops_test_runs').select('id').eq('script_id', script.id).gte('started_at', since).limit(1);
  if (recent?.length) return { state: 'cooldown', message: 'A stress test ran in the last 2 minutes. Try again shortly.' };
  return kick('ops-stress-background', { trigger: clip(triggeredBy, 100) }, 'Stress test started: 25 concurrent synthetic calls.');
}

async function kick(fn, body, okMessage) {
  const base = process.env.OPS_RUNNER_BASE || siteBase();
  if (!base) return { state: 'error', message: 'Site URL unknown (URL env var unset)' };
  try {
    const r = await fetchJson(`${base}/.netlify/functions/${fn}`, { method: 'POST', body });
    if (r.status !== 202 && !r.ok) return { state: 'error', message: `Runner replied HTTP ${r.status}` };
  } catch (err) {
    return { state: 'error', message: err?.name === 'AbortError' ? 'Runner did not answer in time' : err.message };
  }
  return { state: 'queued', message: okMessage };
}
