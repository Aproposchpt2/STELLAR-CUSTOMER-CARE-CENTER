// Synthetic checks and stress tests for the Stellar products. Identical file on the PMA,
// Specialist, Sales and Customer Care Center sites; each site only ever runs the group for its own product
// (see siteProduct in ops-core.mjs), so every site tests itself.
//
// Each check calls a live endpoint the way an ElevenLabs agent would, verifies the
// database row it should create, then deletes everything it created. Synthetic records
// are tagged `synthetic_check_<ts>` so a leftover row (if cleanup ever fails) is obvious.
//
// SAFETY: PMA checks are read-only / auth probes. PMA create_incident and
// record_contact_preference send real SMS and email, so they are never called here.
//
// Results: ops_check_runs (one batch) and ops_test_runs (one row per script).

import { db, siteProduct } from './ops-core.mjs';

const SPECIALIST = 'https://specialist.stellaruc.com';
const SALES = 'https://sales.stellaruc.com';
const PMA = 'https://pma.stellaruc.com';
const CCC = 'https://ccc.stellaruc.com';
const LEAD_TENANT_ID = '5885a020-d363-4c27-910a-c035eda132f5';
const TEST_PHONE = '+10000000000';
const COOLDOWN_SECS = 30;
const HTTP_TIMEOUT_MS = 15000;
const STRESS_CALLS = 25;

async function http(url, { method = 'POST', body, headers = {} } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: method === 'GET' ? headers : { 'Content-Type': 'application/json', ...headers },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

const clean = (v) => String(v || '').trim().replace(/^["']|["']$/g, '');
// Specialist site's own webhook secret (optional until that site enforces one).
function intakeHeaders() {
  const secret = clean(process.env.INTAKE_WEBHOOK_SECRET);
  return secret ? { 'x-intake-secret': secret } : {};
}
// Customer Care Center webhook secret (required by that site).
function cccHeaders() {
  const secret = clean(process.env.CCC_INTAKE_WEBHOOK_SECRET);
  return secret ? { 'x-intake-secret': secret } : {};
}
// Sales webhook secret: SALES_INTAKE_WEBHOOK_SECRET (old name INTAKE_WEBHOOK_SECRET).
function salesHeaders() {
  const secret = clean(process.env.SALES_INTAKE_WEBHOOK_SECRET) || clean(process.env.INTAKE_WEBHOOK_SECRET);
  return secret ? { 'x-intake-secret': secret } : {};
}

// Runs one check; never throws. fn returns {status, detail} or throws (= fail).
async function check(results, product, key, name, fn) {
  const t0 = Date.now();
  let out;
  try {
    out = await fn();
  } catch (err) {
    out = { status: 'fail', detail: err?.name === 'AbortError' ? 'Timed out' : String(err?.message || err) };
  }
  results.push({ product, check_key: key, check_name: name, status: out.status, detail: out.detail?.slice(0, 500) || null, duration_ms: Date.now() - t0 });
}

const pass = (detail) => ({ status: 'pass', detail });
const fail = (detail) => ({ status: 'fail', detail });
const warn = (detail) => ({ status: 'warn', detail });

// ---------------- Support Specialist ----------------
async function supportChecks(sb, tag, results) {
  const intake = `${SPECIALIST}/api/intake/webhook`;

  await check(results, 'support', 'support.site', 'Site is up', async () => {
    const r = await http(`${SPECIALIST}/`, { method: 'GET' });
    return r.status === 200 ? pass('200 OK') : fail(`HTTP ${r.status}`);
  });

  await check(results, 'support', 'support.initiate', 'Call start webhook returns caller data', async () => {
    const r = await http(intake, { body: { caller_id: TEST_PHONE, call_sid: tag, agent_id: 'synthetic' }, headers: intakeHeaders() });
    if (r.status !== 200) return fail(`HTTP ${r.status} ${r.text.slice(0, 120)}`);
    const ok = r.json?.type === 'conversation_initiation_client_data' && r.json?.dynamic_variables?.caller_number;
    return ok ? pass('Returned caller_number and greeting') : fail(`Unexpected reply: ${r.text.slice(0, 160)}`);
  });

  await check(results, 'support', 'support.start_session', 'start_session writes a session', async () => {
    const r = await http(intake, { body: { action: 'start', conversationId: tag, callerPhone: TEST_PHONE }, headers: intakeHeaders() });
    if (r.status !== 200 || !r.json?.interactionId) return fail(`HTTP ${r.status} ${r.text.slice(0, 160)}`);
    const { data, error } = await sb.from('ss_session').select('id').eq('id', r.json.interactionId).maybeSingle();
    if (error) return fail(`DB read failed: ${error.message}`);
    return data ? pass('Session row written') : fail('Endpoint replied but no ss_session row found');
  });

  let ticketNumber = null;
  await check(results, 'support', 'support.ticket_create', 'create_ticket writes a ticket', async () => {
    const r = await http(intake, {
      body: {
        action: 'ticket', conversationId: tag, callSid: tag,
        callerName: 'Synthetic Check', companyName: 'Synthetic Monitoring',
        description: 'Automated synthetic check. Safe to ignore; deleted automatically.',
        category: 'technical', priority: 'standard', phone: TEST_PHONE, preferredContactMethod: 'phone',
      },
      headers: intakeHeaders(),
    });
    if (r.status !== 200 || !r.json?.ok) return fail(`HTTP ${r.status} ${r.text.slice(0, 160)}`);
    ticketNumber = r.json.ticket_number;
    const { data, error } = await sb.from('ss_tickets').select('ticket_number').eq('conversation_id', tag);
    if (error) return fail(`DB read failed: ${error.message}`);
    return data?.length === 1 ? pass(`Ticket ${ticketNumber} written`) : fail(`Expected 1 ticket row, found ${data?.length ?? 0}`);
  });

  await check(results, 'support', 'support.ticket_dedupe', 'Correction updates the same ticket (no duplicates)', async () => {
    if (!ticketNumber) return fail('Skipped: ticket was not created');
    const r = await http(intake, {
      body: {
        action: 'ticket', conversationId: tag, callSid: tag,
        callerName: 'Synthetic Check', description: 'Automated synthetic check (correction).',
        category: 'technical', priority: 'standard', phone: '+10000000001', preferredContactMethod: 'phone',
      },
      headers: intakeHeaders(),
    });
    if (r.status !== 200 || !r.json?.ok) return fail(`HTTP ${r.status} ${r.text.slice(0, 160)}`);
    const { count } = await sb.from('ss_tickets').select('id', { count: 'exact', head: true }).eq('conversation_id', tag);
    if (r.json.updated && r.json.ticket_number === ticketNumber && count === 1) return pass('Updated in place');
    return fail(`updated=${r.json.updated} ticket=${r.json.ticket_number} rows=${count}`);
  });

  await check(results, 'support', 'support.postcall_secured', 'Post-call webhook is secured', async () => {
    const r = await http(`${SPECIALIST}/api/postcall`, { body: {} });
    const err = r.json?.error;
    if (r.status === 401 && err === 'NO_POSTCALL_SECRET') return fail('ELEVENLABS_POSTCALL_SECRET is not set on Netlify, so every call log is rejected');
    if (r.status === 401) return pass('Rejects unsigned requests');
    return fail(`Expected 401 for an unsigned request, got HTTP ${r.status}`);
  });

  await check(results, 'support', 'support.call_logs', 'Call logs arriving (last 7 days)', async () => {
    const since = new Date(Date.now() - 7 * 864e5).toISOString();
    const { count, error } = await sb.from('ss_call_log').select('id', { count: 'exact', head: true }).gte('created_at', since);
    if (error) return fail(`DB read failed: ${error.message}`);
    return count > 0 ? pass(`${count} call logs`) : warn('No call logs in 7 days: the post-call webhook may not be wired to this site');
  });

  // Cleanup: tickets (+ contact prefs) and sessions created by this run.
  await check(results, 'support', 'support.cleanup', 'Cleanup of synthetic rows', async () => {
    const { data: tix } = await sb.from('ss_tickets').select('id').eq('conversation_id', tag);
    const ids = (tix || []).map((t) => t.id);
    if (ids.length) await sb.from('ss_contact_preferences').delete().in('ticket_id', ids);
    const a = await sb.from('ss_tickets').delete().eq('conversation_id', tag);
    const b = await sb.from('ss_session').delete().eq('conversation_id', tag);
    const errs = [a.error, b.error].filter(Boolean).map((e) => e.message);
    return errs.length ? fail(errs.join('; ')) : pass('Synthetic rows removed');
  });
}

// ---------------- Sales Specialist ----------------
// sales.stellaruc.com webhook -> Lead Management pipeline (ai4cc_interactions, ai4cc_leads).
// Synthetic calls use an opaque identifier, so they never touch a real contact, and the
// cleanup check removes every row they created (interaction, lead, activities, contact, audit).
async function salesChecks(sb, tag, results) {
  const intake = `${SALES}/api/intake/webhook`;

  await check(results, 'sales', 'sales.site', 'Site is up', async () => {
    const r = await http(`${SALES}/`, { method: 'GET' });
    return r.status === 200 ? pass('200 OK') : fail(`HTTP ${r.status}`);
  });

  // Same request the Sales agent's start_session tool sends.
  let interactionId = null;
  await check(results, 'sales', 'sales.start_session', 'start_session opens a call record', async () => {
    const r = await http(intake, { body: { action: 'start', conversationId: tag, callerPhone: TEST_PHONE }, headers: salesHeaders() });
    if (r.status !== 200 || !r.json?.interactionId) return fail(`HTTP ${r.status}: the Sales agent's tools are being rejected (${r.text.slice(0, 120)})`);
    interactionId = r.json.interactionId;
    const { data, error } = await sb.from('ai4cc_interactions').select('id').eq('id', interactionId).maybeSingle();
    if (error) return fail(`DB read failed: ${error.message}`);
    return data ? pass('Interaction row written') : fail('Endpoint replied but no ai4cc_interactions row found');
  });

  await check(results, 'sales', 'sales.submit_lead', 'submit_lead creates a lead', async () => {
    if (!interactionId) return fail('Skipped: start_session failed');
    const r = await http(intake, {
      body: {
        action: 'submit', interactionId, callerName: 'Synthetic Check', businessName: 'Synthetic Monitoring',
        phone: TEST_PHONE, serviceInterest: 'Synthetic check', description: 'Automated synthetic check. Safe to ignore; deleted automatically.',
      },
      headers: salesHeaders(),
    });
    if (r.status !== 200 || !r.json?.ok) return fail(`HTTP ${r.status} ${r.text.slice(0, 160)}`);
    const { data, error } = await sb.from('ai4cc_leads').select('id').eq('originating_interaction_id', interactionId);
    if (error) return fail(`DB read failed: ${error.message}`);
    return data?.length === 1 ? pass('Lead written to Lead Management') : fail(`Expected 1 lead, found ${data?.length ?? 0}`);
  });

  await check(results, 'sales', 'sales.cleanup', 'Cleanup of synthetic rows', async () => {
    const { data: ints } = await sb.from('ai4cc_interactions').select('id').eq('tenant_id', LEAD_TENANT_ID).eq('external_id', tag);
    const intIds = (ints || []).map((i) => i.id);
    if (!intIds.length) return pass('Nothing to remove');
    const { data: leads } = await sb.from('ai4cc_leads').select('id, contact_id').in('originating_interaction_id', intIds);
    const leadIds = (leads || []).map((l) => l.id);
    const contactIds = [...new Set((leads || []).map((l) => l.contact_id))];
    const errs = [];
    const del = async (q) => { const { error } = await q; if (error) errs.push(error.message); };
    if (leadIds.length) {
      await del(sb.from('ai4cc_audit_logs').delete().in('resource_id', leadIds));
      await del(sb.from('ai4cc_lead_activities').delete().in('lead_id', leadIds));
      await del(sb.from('ai4cc_leads').delete().in('id', leadIds));
    }
    // Contacts created for synthetic calls only (opaque identifier = this run's tag).
    if (contactIds.length) await del(sb.from('ai4cc_contacts').delete().in('id', contactIds).eq('metadata->>customerIdentifier', tag));
    await del(sb.from('ai4cc_interactions').delete().in('id', intIds));
    return errs.length ? fail(errs.join('; ')) : pass('Synthetic rows removed');
  });
}

// ---------------- Customer Care Center ----------------
// ccc.stellaruc.com webhook -> Lead Management pipeline. Synthetic calls skip the owner email.
async function cccChecks(sb, tag, results) {
  const intake = `${CCC}/api/ccc/intake`;

  await check(results, 'ccc', 'ccc.site', 'Site is up', async () => {
    const r = await http(`${CCC}/`, { method: 'GET' });
    return r.status === 200 ? pass('200 OK') : fail(`HTTP ${r.status}`);
  });

  // Same request the Customer Care Center agent's start_session tool sends.
  let interactionId = null;
  await check(results, 'ccc', 'ccc.start_session', 'start_session opens a call record', async () => {
    const r = await http(intake, { body: { action: 'start', conversationId: tag, callerPhone: TEST_PHONE }, headers: cccHeaders() });
    if (r.status !== 200 || !r.json?.interactionId) return fail(`HTTP ${r.status}: the Customer Care Center agent's tools are being rejected (${r.text.slice(0, 120)})`);
    interactionId = r.json.interactionId;
    const { data, error } = await sb.from('ai4cc_interactions').select('id').eq('id', interactionId).maybeSingle();
    if (error) return fail(`DB read failed: ${error.message}`);
    return data ? pass('Interaction row written') : fail('Endpoint replied but no ai4cc_interactions row found');
  });

  await check(results, 'ccc', 'ccc.submit_lead', 'submit_lead creates a lead', async () => {
    if (!interactionId) return fail('Skipped: start_session failed');
    const r = await http(intake, {
      body: {
        action: 'submit', interactionId, callerName: 'Synthetic Check', businessName: 'Synthetic Monitoring',
        phone: TEST_PHONE, serviceInterest: 'Appointment request - synthetic check', description: 'Automated synthetic check. Safe to ignore; deleted automatically.',
      },
      headers: cccHeaders(),
    });
    if (r.status !== 200 || !r.json?.ok) return fail(`HTTP ${r.status} ${r.text.slice(0, 160)}`);
    const { data, error } = await sb.from('ai4cc_leads').select('id').eq('originating_interaction_id', interactionId);
    if (error) return fail(`DB read failed: ${error.message}`);
    return data?.length === 1 ? pass('Lead written to Lead Management') : fail(`Expected 1 lead, found ${data?.length ?? 0}`);
  });

  await check(results, 'ccc', 'ccc.cleanup', 'Cleanup of synthetic rows', async () => {
    const { data: ints } = await sb.from('ai4cc_interactions').select('id').eq('tenant_id', LEAD_TENANT_ID).eq('external_id', tag);
    const intIds = (ints || []).map((i) => i.id);
    if (!intIds.length) return pass('Nothing to remove');
    const { data: leads } = await sb.from('ai4cc_leads').select('id, contact_id').in('originating_interaction_id', intIds);
    const leadIds = (leads || []).map((l) => l.id);
    const contactIds = [...new Set((leads || []).map((l) => l.contact_id))];
    const errs = [];
    const del = async (q) => { const { error } = await q; if (error) errs.push(error.message); };
    if (leadIds.length) {
      await del(sb.from('ai4cc_audit_logs').delete().in('resource_id', leadIds));
      await del(sb.from('ai4cc_lead_activities').delete().in('lead_id', leadIds));
      await del(sb.from('ai4cc_leads').delete().in('id', leadIds));
    }
    // Contacts created for synthetic calls only (opaque identifier = this run's tag).
    if (contactIds.length) await del(sb.from('ai4cc_contacts').delete().in('id', contactIds).eq('metadata->>customerIdentifier', tag));
    await del(sb.from('ai4cc_interactions').delete().in('id', intIds));
    return errs.length ? fail(errs.join('; ')) : pass('Synthetic rows removed');
  });
}

// ---------------- Property Management Assistant ----------------
async function pmaChecks(sb, _tag, results) {
  await check(results, 'pma', 'pma.site', 'Site is up', async () => {
    const r = await http(`${PMA}/`, { method: 'GET' });
    return r.status === 200 ? pass('200 OK') : fail(`HTTP ${r.status}`);
  });

  // Auth probes only: no key -> must be 401. Proves the function is deployed and guarded.
  await check(results, 'pma', 'pma.resident_tool_guarded', 'Resident tool endpoint is up and guarded', async () => {
    const r = await http(`${PMA}/api/tools/cedar-elevenlabs`, { body: { tool: 'get_case_status' } });
    return r.status === 401 ? pass('Rejects calls without the tool key') : fail(`Expected 401, got HTTP ${r.status}`);
  });

  await check(results, 'pma', 'pma.vendor_tool_guarded', 'Vendor tool endpoint is up and guarded', async () => {
    const r = await http(`${PMA}/api/tools/pma-vendor`, { body: { action: 'list_work_orders' } });
    return r.status === 401 ? pass('Rejects calls without the tool key') : fail(`Expected 401, got HTTP ${r.status}`);
  });

  for (const table of ['pma_voice_sessions', 'pma_maintenance_requests', 'pma_call_log']) {
    await check(results, 'pma', `pma.table.${table}`, `Backend can read ${table}`, async () => {
      const { error } = await sb.from(table).select('id', { count: 'exact', head: true });
      return error ? fail(error.message || error.code || error.hint || 'Permission denied for the backend (missing service_role grant?)') : pass('Readable');
    });
  }
}

// ---------------- Orchestration ----------------
const GROUPS = { support: supportChecks, sales: salesChecks, pma: pmaChecks, ccc: cccChecks };
const isStressKey = (k) => /\.stress$/.test(String(k || ''));

// Backend scripts for a product, excluding its stress test (run separately).
async function backendScripts(sb, product) {
  const { data } = await sb.from('ops_test_scripts').select('id, check_key, product')
    .eq('layer', 'backend').eq('product', product);
  return (data || []).filter((s) => !isStressKey(s.check_key));
}

// Per-product cooldown: any run of this product's backend scripts in the last 30 s.
export async function inCooldown(product, sb = db()) {
  const ids = (await backendScripts(sb, product)).map((s) => s.id);
  if (!ids.length) return false;
  const since = new Date(Date.now() - COOLDOWN_SECS * 1000).toISOString();
  const { data } = await sb.from('ops_test_runs').select('id').in('script_id', ids).gte('started_at', since).limit(1);
  return !!data?.length;
}

// Runs this site's backend group. Setup and cleanup stay paired inside the group.
export async function runBackendChecks(trigger = 'manual', product = siteProduct()) {
  if (!GROUPS[product]) throw new Error(`Unknown product: ${product}`);
  const sb = db();
  if (await inCooldown(product, sb)) return { skipped: true, reason: 'cooldown' };

  const { data: batch, error } = await sb.from('ops_check_runs').insert({ trigger: String(trigger).slice(0, 60), layer: 'backend' }).select('id').single();
  if (error) throw new Error(`Could not start run: ${error.message}`);

  const scripts = await backendScripts(sb, product);
  const byKey = Object.fromEntries(scripts.map((s) => [s.check_key, s.id]));
  const startedAt = new Date().toISOString();
  const { data: openRows } = await sb.from('ops_test_runs')
    .insert(scripts.map((s) => ({ script_id: s.id, batch_id: batch.id, status: 'running', triggered_by: String(trigger).slice(0, 120), started_at: startedAt })))
    .select('id, script_id');
  const rowByScript = Object.fromEntries((openRows || []).map((r) => [r.script_id, r.id]));

  const tag = `synthetic_check_${Date.now()}`;
  const results = [];
  try { await GROUPS[product](sb, tag, results); } catch (err) { console.error('[ops-runner] group crashed:', err.message); }
  const finishedAt = new Date().toISOString();

  for (const r of results) {
    const scriptId = byKey[r.check_key];
    if (!scriptId) continue;
    const patch = { status: r.status, summary: r.detail, detail: { check: r.check_name, duration_ms: r.duration_ms }, duration_ms: r.duration_ms, finished_at: finishedAt };
    if (rowByScript[scriptId]) await sb.from('ops_test_runs').update(patch).eq('id', rowByScript[scriptId]);
    else await sb.from('ops_test_runs').insert({ ...patch, script_id: scriptId, batch_id: batch.id, triggered_by: String(trigger).slice(0, 120), started_at: startedAt });
  }
  const reported = new Set(results.map((r) => byKey[r.check_key]).filter(Boolean));
  for (const [scriptId, rowId] of Object.entries(rowByScript)) {
    if (!reported.has(scriptId)) await sb.from('ops_test_runs').update({ status: 'error', summary: 'No result reported', finished_at: finishedAt }).eq('id', rowId);
  }

  const tally = (st) => results.filter((r) => r.status === st).length;
  const failed = tally('fail');
  await sb.from('ops_check_runs').update({ finished_at: finishedAt, status: failed ? 'fail' : 'pass', passed: tally('pass'), failed, warned: tally('warn') }).eq('id', batch.id);
  return { batch_id: batch.id, product, passed: tally('pass'), failed, warned: tally('warn') };
}

// ---------------- Stress tests ----------------
// N concurrent synthetic calls against this site's own webhook, then a database count
// check and full cleanup. Runs on demand only (never on a schedule).

function stats(steps) {
  const lat = steps.map((s) => s.ms).sort((a, b) => a - b);
  const pct = (p) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] : null);
  return { requests: steps.length, errors: steps.filter((s) => !s.ok).length, p50_ms: pct(0.5), p95_ms: pct(0.95), max_ms: lat[lat.length - 1] ?? null };
}
async function timed(fn) {
  const t0 = Date.now();
  try { const r = await fn(); return { ms: Date.now() - t0, ...r }; }
  catch (err) { return { ms: Date.now() - t0, ok: false, error: err?.name === 'AbortError' ? 'timed out' : err.message }; }
}

async function salesStress(sb, run) {
  const intake = `${SALES}/api/intake/webhook`;
  const steps = [];
  const one = async (i) => {
    const st = await timed(async () => { const r = await http(intake, { body: { action: 'start', conversationId: `${run}_${i}`, callerPhone: TEST_PHONE }, headers: salesHeaders() }); return { ok: r.status === 200 && !!r.json?.interactionId, id: r.json?.interactionId, error: r.json?.reason || r.json?.error || (r.status !== 200 ? `HTTP ${r.status}` : null) }; });
    steps.push(st); if (!st.ok) return;
    const body = { action: 'submit', interactionId: st.id, callerName: `Synthetic ${i}`, businessName: 'Synthetic Load Test', phone: TEST_PHONE, description: 'Automated stress test. Safe to ignore; deleted automatically.' };
    steps.push(await timed(async () => { const r = await http(intake, { body: { ...body, serviceInterest: 'Sales Specialist' }, headers: salesHeaders() }); return { ok: r.status === 200 && r.json?.ok === true && r.json?.updated === false, error: r.json?.reason || r.json?.error }; }));
    steps.push(await timed(async () => { const r = await http(intake, { body: { ...body, serviceInterest: 'Support Specialist' }, headers: salesHeaders() }); return { ok: r.status === 200 && r.json?.ok === true && r.json?.updated === true, error: r.json?.reason || r.json?.error }; }));
  };
  const t0 = Date.now();
  await Promise.all(Array.from({ length: STRESS_CALLS }, (_, i) => one(i)));
  const wall = Date.now() - t0;

  // Verify: one completed interaction and exactly one lead per call.
  const { data: ints } = await sb.from('ai4cc_interactions').select('id, status').eq('tenant_id', LEAD_TENANT_ID).like('external_id', `${run}_%`);
  const intIds = (ints || []).map((x) => x.id);
  const { data: leads } = intIds.length ? await sb.from('ai4cc_leads').select('id, contact_id, originating_interaction_id').in('originating_interaction_id', intIds) : { data: [] };
  const db_check = { calls: STRESS_CALLS, interactions: intIds.length, completed: (ints || []).filter((x) => x.status === 'completed').length, leads: leads?.length || 0, duplicate_leads: (leads?.length || 0) - new Set((leads || []).map((l) => l.originating_interaction_id)).size };

  // Cleanup: audit logs, activities, leads, synthetic contacts, interactions.
  const leadIds = (leads || []).map((l) => l.id);
  const contactIds = [...new Set((leads || []).map((l) => l.contact_id))];
  const errs = [];
  const del = async (q) => { const { error } = await q; if (error) errs.push(error.message); };
  if (leadIds.length) {
    await del(sb.from('ai4cc_audit_logs').delete().in('resource_id', leadIds));
    await del(sb.from('ai4cc_lead_activities').delete().in('lead_id', leadIds));
    await del(sb.from('ai4cc_leads').delete().in('id', leadIds));
  }
  if (contactIds.length) await del(sb.from('ai4cc_contacts').delete().in('id', contactIds).like('metadata->>customerIdentifier', 'synthetic_check_%'));
  if (intIds.length) await del(sb.from('ai4cc_interactions').delete().in('id', intIds));
  const dbOk = db_check.interactions === STRESS_CALLS && db_check.completed === STRESS_CALLS && db_check.leads === STRESS_CALLS && db_check.duplicate_leads === 0;
  return { wall_ms: wall, steps, db_check, db_ok: dbOk, cleanup_errors: errs };
}

async function cccStress(sb, run) {
  const intake = `${CCC}/api/ccc/intake`;
  const steps = [];
  const one = async (i) => {
    const st = await timed(async () => { const r = await http(intake, { body: { action: 'start', conversationId: `${run}_${i}`, callerPhone: TEST_PHONE }, headers: cccHeaders() }); return { ok: r.status === 200 && !!r.json?.interactionId, id: r.json?.interactionId, error: r.json?.reason || r.json?.error || (r.status !== 200 ? `HTTP ${r.status}` : null) }; });
    steps.push(st); if (!st.ok) return;
    const body = { action: 'submit', interactionId: st.id, callerName: `Synthetic ${i}`, businessName: 'Synthetic Load Test', phone: TEST_PHONE, description: 'Automated stress test. Safe to ignore; deleted automatically.' };
    steps.push(await timed(async () => { const r = await http(intake, { body: { ...body, serviceInterest: 'Appointment request' }, headers: cccHeaders() }); return { ok: r.status === 200 && r.json?.ok === true && r.json?.updated === false, error: r.json?.reason || r.json?.error }; }));
    steps.push(await timed(async () => { const r = await http(intake, { body: { ...body, serviceInterest: 'Service question' }, headers: cccHeaders() }); return { ok: r.status === 200 && r.json?.ok === true && r.json?.updated === true, error: r.json?.reason || r.json?.error }; }));
  };
  const t0 = Date.now();
  await Promise.all(Array.from({ length: STRESS_CALLS }, (_, i) => one(i)));
  const wall = Date.now() - t0;

  // Verify: one completed interaction and exactly one lead per call.
  const { data: ints } = await sb.from('ai4cc_interactions').select('id, status').eq('tenant_id', LEAD_TENANT_ID).like('external_id', `${run}_%`);
  const intIds = (ints || []).map((x) => x.id);
  const { data: leads } = intIds.length ? await sb.from('ai4cc_leads').select('id, contact_id, originating_interaction_id').in('originating_interaction_id', intIds) : { data: [] };
  const db_check = { calls: STRESS_CALLS, interactions: intIds.length, completed: (ints || []).filter((x) => x.status === 'completed').length, leads: leads?.length || 0, duplicate_leads: (leads?.length || 0) - new Set((leads || []).map((l) => l.originating_interaction_id)).size };

  // Cleanup: audit logs, activities, leads, synthetic contacts, interactions.
  const leadIds = (leads || []).map((l) => l.id);
  const contactIds = [...new Set((leads || []).map((l) => l.contact_id))];
  const errs = [];
  const del = async (q) => { const { error } = await q; if (error) errs.push(error.message); };
  if (leadIds.length) {
    await del(sb.from('ai4cc_audit_logs').delete().in('resource_id', leadIds));
    await del(sb.from('ai4cc_lead_activities').delete().in('lead_id', leadIds));
    await del(sb.from('ai4cc_leads').delete().in('id', leadIds));
  }
  if (contactIds.length) await del(sb.from('ai4cc_contacts').delete().in('id', contactIds).like('metadata->>customerIdentifier', 'synthetic_check_%'));
  if (intIds.length) await del(sb.from('ai4cc_interactions').delete().in('id', intIds));
  const dbOk = db_check.interactions === STRESS_CALLS && db_check.completed === STRESS_CALLS && db_check.leads === STRESS_CALLS && db_check.duplicate_leads === 0;
  return { wall_ms: wall, steps, db_check, db_ok: dbOk, cleanup_errors: errs };
}

async function supportStress(sb, run) {
  const intake = `${SPECIALIST}/api/intake/webhook`;
  const steps = [];
  const one = async (i) => {
    const conv = `${run}_${i}`;
    steps.push(await timed(async () => { const r = await http(intake, { body: { action: 'start', conversationId: conv, callerPhone: TEST_PHONE }, headers: intakeHeaders() }); return { ok: r.status === 200 && !!r.json?.interactionId, error: r.json?.error || (r.status !== 200 ? `HTTP ${r.status}` : null) }; }));
    const ticket = { action: 'ticket', conversationId: conv, callSid: conv, callerName: `Synthetic ${i}`, companyName: 'Synthetic Load Test', description: 'Automated stress test. Safe to ignore; deleted automatically.', category: 'technical', priority: 'standard', preferredContactMethod: 'phone' };
    steps.push(await timed(async () => { const r = await http(intake, { body: { ...ticket, phone: TEST_PHONE }, headers: intakeHeaders() }); return { ok: r.status === 200 && r.json?.ok === true && !r.json?.updated, error: r.json?.error }; }));
    steps.push(await timed(async () => { const r = await http(intake, { body: { ...ticket, phone: '+10000000001' }, headers: intakeHeaders() }); return { ok: r.status === 200 && r.json?.ok === true && r.json?.updated === true, error: r.json?.error }; }));
  };
  const t0 = Date.now();
  await Promise.all(Array.from({ length: STRESS_CALLS }, (_, i) => one(i)));
  const wall = Date.now() - t0;

  const { data: sessions } = await sb.from('ss_session').select('id').like('conversation_id', `${run}_%`);
  const { data: tix } = await sb.from('ss_tickets').select('id, conversation_id').like('conversation_id', `${run}_%`);
  const db_check = { calls: STRESS_CALLS, sessions: sessions?.length || 0, tickets: tix?.length || 0, duplicate_tickets: (tix?.length || 0) - new Set((tix || []).map((t) => t.conversation_id)).size };

  const errs = [];
  const del = async (q) => { const { error } = await q; if (error) errs.push(error.message); };
  const ids = (tix || []).map((t) => t.id);
  if (ids.length) await del(sb.from('ss_contact_preferences').delete().in('ticket_id', ids));
  await del(sb.from('ss_tickets').delete().like('conversation_id', `${run}_%`));
  await del(sb.from('ss_session').delete().like('conversation_id', `${run}_%`));
  const dbOk = db_check.sessions === STRESS_CALLS && db_check.tickets === STRESS_CALLS && db_check.duplicate_tickets === 0;
  return { wall_ms: wall, steps, db_check, db_ok: dbOk, cleanup_errors: errs };
}

// PMA: read-only and auth-probe requests only (its real tools text residents).
async function pmaStress(sb) {
  const steps = [];
  const one = async () => {
    steps.push(await timed(async () => { const r = await http(`${PMA}/`, { method: 'GET' }); return { ok: r.status === 200, error: r.status !== 200 ? `HTTP ${r.status}` : null }; }));
    steps.push(await timed(async () => { const r = await http(`${PMA}/api/tools/cedar-elevenlabs`, { body: { tool: 'get_case_status' } }); return { ok: r.status === 401, error: r.status !== 401 ? `expected 401, got ${r.status}` : null }; }));
    steps.push(await timed(async () => { const r = await http(`${PMA}/api/tools/pma-vendor`, { body: { action: 'list_work_orders' } }); return { ok: r.status === 401, error: r.status !== 401 ? `expected 401, got ${r.status}` : null }; }));
  };
  const t0 = Date.now();
  await Promise.all(Array.from({ length: STRESS_CALLS }, () => one()));
  const wall = Date.now() - t0;
  const reads = await Promise.all(['pma_voice_sessions', 'pma_maintenance_requests', 'pma_call_log'].map(async (t) => {
    const { error } = await sb.from(t).select('id', { count: 'exact', head: true });
    return [t, error ? error.message : 'ok'];
  }));
  const db_check = Object.fromEntries(reads);
  return { wall_ms: wall, steps, db_check, db_ok: reads.every(([, v]) => v === 'ok'), cleanup_errors: [] };
}

const STRESS = { sales: salesStress, support: supportStress, pma: pmaStress, ccc: cccStress };

// Runs the stress test for this site's product and records it on the `<product>.stress` script.
export async function runStress(trigger = 'manual', product = siteProduct()) {
  const sb = db();
  const { data: script } = await sb.from('ops_test_scripts').select('id').eq('product', product).eq('check_key', `${product}.stress`).maybeSingle();
  if (!script) throw new Error(`No ${product}.stress script in ops_test_scripts`);
  const startedAt = new Date();
  const { data: row, error } = await sb.from('ops_test_runs').insert({ script_id: script.id, status: 'running', triggered_by: String(trigger).slice(0, 120), started_at: startedAt.toISOString(), summary: `Running ${STRESS_CALLS} concurrent synthetic calls` }).select('id').single();
  if (error) throw new Error(error.message);

  let out;
  try { out = await STRESS[product](sb, `synthetic_check_stress_${Date.now()}`); }
  catch (err) { out = { steps: [], db_ok: false, cleanup_errors: [], crash: err.message }; }
  const s = stats(out.steps);
  const firstErrors = [...new Set(out.steps.filter((x) => !x.ok).map((x) => x.error || 'failed'))].slice(0, 5);
  const status = out.crash || out.cleanup_errors.length || !out.db_ok || s.errors ? 'fail' : (s.p95_ms > 8000 ? 'warn' : 'pass');
  const summary = out.crash ? `Crashed: ${out.crash}`
    : `${STRESS_CALLS} concurrent calls, ${s.requests} requests, ${s.errors} errors. p50 ${s.p50_ms} ms, p95 ${s.p95_ms} ms, max ${s.max_ms} ms.` +
      (out.db_ok ? ' Database counts correct.' : ' Database counts WRONG.') + (out.cleanup_errors.length ? ' Cleanup failed.' : ' Cleaned up.');
  const finished = new Date();
  await sb.from('ops_test_runs').update({
    status, summary, finished_at: finished.toISOString(), duration_ms: finished - startedAt,
    detail: { kind: 'stress', concurrent_calls: STRESS_CALLS, wall_ms: out.wall_ms, ...s, db_check: out.db_check, cleanup_errors: out.cleanup_errors, first_errors: firstErrors },
  }).eq('id', row.id);
  return { status, summary };
}
