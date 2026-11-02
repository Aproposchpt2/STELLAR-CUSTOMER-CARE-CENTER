// Simulation Testing admin API (routed at /api/ops/*). Identical file on the PMA,
// Specialist and Sales sites; each site manages only its own product (siteProduct()).
// Every route needs a Supabase session token whose email is in ops_admins.
//
//   GET  /api/ops/scripts                 this site's scripts + latest runs, plus a
//                                         read-only health overview of every product
//   GET  /api/ops/scripts/:slug           one script + latest run (drawer)
//   GET  /api/ops/scripts/:slug/runs      run history (?limit=50, max 200)
//   POST /api/ops/run      {slug}         run one script (this site's product only)
//   POST /api/ops/run-all                 run every enabled test for this site
//   POST /api/ops/stress                  start this site's stress test (on demand)

import {
  PRODUCTS, db, listScripts, getScript, latestRuns, runHistory, siteProduct,
  refreshOpenRuns, startAgentRuns, startBackendGroup, startStress,
} from './lib/ops-core.mjs';

const isStress = (s) => /\.stress$/.test(String(s?.check_key || ''));
const RUN_CODE = { queued: 202, cooldown: 429, running: 409, error: 502, none: 404 };

const HEADERS = {
  'content-type': 'application/json',
  'cache-control': 'private, no-store',
  'x-robots-tag': 'noindex, nofollow',
};
const json = (statusCode, body) => ({ statusCode, headers: HEADERS, body: JSON.stringify(body) });

// Per-user rate limits (in-process, best effort; same pattern as pma-auth.js).
const _rl = new Map();
function allow(key, max, windowMs = 60_000) {
  const now = Date.now();
  const e = _rl.get(key);
  if (!e || e.r <= now) { _rl.set(key, { c: 1, r: now + windowMs }); return true; }
  if (e.c >= max) return false;
  e.c++; return true;
}

let _admins = { at: 0, set: new Set() };
async function adminEmails() {
  if (Date.now() - _admins.at < 60_000) return _admins.set;
  const { data, error } = await db().from('ops_admins').select('email');
  if (error) throw new Error(`ops_admins: ${error.message}`);
  _admins = { at: Date.now(), set: new Set((data || []).map((r) => String(r.email || '').trim().toLowerCase())) };
  return _admins.set;
}

async function authenticate(event) {
  const h = event.headers || {};
  const auth = h.authorization || h.Authorization || '';
  if (!auth.startsWith('Bearer ')) return { status: 401, error: 'Sign in required' };
  const { data, error } = await db().auth.getUser(auth.slice(7));
  const email = data?.user?.email?.toLowerCase();
  if (error || !email) return { status: 401, error: 'Session expired. Sign in again.' };
  if (!(await adminEmails()).has(email)) return { status: 403, error: 'This account is not on the testing admin list.' };
  if (!allow(`all:${email}`, 90)) return { status: 429, error: 'Too many requests. Slow down a moment.' };
  return { email };
}

const SLUG = /^[a-z0-9][a-z0-9._-]{0,99}$/i;

export const handler = async (event) => {
  if (!['GET', 'POST'].includes(event.httpMethod)) return json(405, { error: 'Method not allowed' });
  try {
    const who = await authenticate(event);
    if (who.error) return json(who.status, { error: who.error });
    const trigger = `admin:${who.email}`;

    const path = String(event.path || '').replace(/^.*?\/api\/ops\/?/, '').replace(/^\.netlify\/functions\/ops-admin-api\/?/, '');
    const seg = path.split('/').filter(Boolean).map(decodeURIComponent);
    let body = {};
    if (event.body) {
      try { body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body); }
      catch { return json(400, { error: 'Invalid JSON' }); }
    }

    // GET /scripts
    if (event.httpMethod === 'GET' && seg[0] === 'scripts' && seg.length === 1) {
      const product = siteProduct();
      await refreshOpenRuns();
      const all = await listScripts();
      const latest = await latestRuns(all.map((s) => s.id));
      const overview = Object.fromEntries(PRODUCTS.map((p) => [p, { pass: 0, fail: 0, warn: 0, running: 0, never: 0, last_run_at: null }]));
      for (const s of all) {
        if (s.enabled === false || !overview[s.product] || isStress(s)) continue;
        const r = latest[s.id]; const o = overview[s.product];
        const st = !r ? 'never' : r.status === 'error' ? 'fail' : (r.status === 'queued' ? 'running' : r.status);
        o[st] = (o[st] || 0) + 1;
        if (r?.started_at && (!o.last_run_at || r.started_at > o.last_run_at)) o.last_run_at = r.started_at;
      }
      return json(200, {
        product,
        scripts: all.filter((s) => s.product === product).map((s) => ({ ...s, is_stress: isStress(s), latest_run: latest[s.id] || null })),
        overview,
        email: who.email,
        server_time: new Date().toISOString(),
      });
    }

    // GET /scripts/:slug and /scripts/:slug/runs
    if (event.httpMethod === 'GET' && seg[0] === 'scripts' && seg[1]) {
      if (!SLUG.test(seg[1])) return json(400, { error: 'Bad script id' });
      const script = await getScript(seg[1]);
      if (!script) return json(404, { error: 'Script not found' });
      script.is_stress = isStress(script);
      await refreshOpenRuns({ scriptId: script.id });
      if (seg.length === 2) {
        const latest = await latestRuns([script.id]);
        return json(200, { script, latest_run: latest[script.id] || null });
      }
      if (seg.length === 3 && seg[2] === 'runs') {
        const n = Math.min(Math.max(parseInt(event.queryStringParameters?.limit, 10) || 50, 1), 200);
        return json(200, { script, runs: await runHistory(script.id, n) });
      }
    }

    // POST /run {slug}
    if (event.httpMethod === 'POST' && seg[0] === 'run' && seg.length === 1) {
      if (!allow(`run:${who.email}`, 12)) return json(429, { error: 'Too many runs in a minute. Wait a moment.' });
      const slug = String(body.slug || '');
      if (!SLUG.test(slug)) return json(400, { error: 'slug is required' });
      const script = await getScript(slug);
      if (!script) return json(404, { error: 'Script not found' });
      if (script.enabled === false) return json(409, { error: 'This script is disabled.' });
      if (script.product !== siteProduct()) return json(403, { error: `Run this from the ${script.product} site's panel.` });

      if (isStress(script)) {
        const r = await startStress(trigger);
        return json(RUN_CODE[r.state] || 500, r.state === 'queued' ? { state: 'queued', message: r.message } : { error: r.message, state: r.state });
      }
      if (script.layer === 'agent') {
        const r = await startAgentRuns([script], trigger);
        if (r.started.length) return json(200, { state: 'running', run: r.started[0] });
        if (r.skipped.length) return json(409, { error: 'This script is already running.' });
        return json(502, { error: r.errors[0]?.error || 'Could not start the test' });
      }
      if (script.layer === 'backend') {
        const r = await startBackendGroup(script.product, trigger);
        const code = RUN_CODE[r.state] || 500;
        return json(code, r.state === 'queued' ? { state: 'queued', product: script.product, message: r.message } : { error: r.message, state: r.state });
      }
      return json(400, { error: `Unknown layer: ${script.layer}` });
    }

    // POST /run-all {product}
    if (event.httpMethod === 'POST' && seg[0] === 'run-all' && seg.length === 1) {
      if (!allow(`run:${who.email}`, 12)) return json(429, { error: 'Too many runs in a minute. Wait a moment.' });
      const product = siteProduct();
      const scripts = (await listScripts()).filter((s) => s.product === product && s.enabled !== false && !isStress(s));
      const agent = scripts.filter((s) => s.layer === 'agent');
      const hasBackend = scripts.some((s) => s.layer === 'backend');
      const [a, b] = await Promise.all([
        agent.length ? startAgentRuns(agent, trigger) : { started: [], skipped: [], errors: [] },
        hasBackend ? startBackendGroup(product, trigger) : { state: 'none', message: 'No backend scripts' },
      ]);
      return json(200, {
        product,
        agent: { started: a.started.length, skipped: a.skipped, errors: a.errors },
        backend: b,
      });
    }

    // POST /stress
    if (event.httpMethod === 'POST' && seg[0] === 'stress' && seg.length === 1) {
      if (!allow(`stress:${who.email}`, 3)) return json(429, { error: 'Too many stress tests in a minute.' });
      const r = await startStress(trigger);
      return json(RUN_CODE[r.state] || 500, r.state === 'queued' ? { state: 'queued', message: r.message } : { error: r.message, state: r.state });
    }

    return json(404, { error: 'Not found' });
  } catch (err) {
    console.error(JSON.stringify({ event: 'ops_admin_api_error', path: event.path, error: err?.message }));
    return json(500, { error: err?.message?.startsWith('SUPABASE_NOT_CONFIGURED') ? 'Database is not configured on this site' : 'Server error. Try again.' });
  }
};
