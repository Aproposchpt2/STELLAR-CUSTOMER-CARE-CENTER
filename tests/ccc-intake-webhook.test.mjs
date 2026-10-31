// node --test tests/   (no network, no real database)
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'crypto';
import { setDbForTests, TENANT_ID } from '../netlify/functions/lib/ccc-store.mjs';
import { handler } from '../netlify/functions/ccc-intake-webhook.mjs';
import { handler as postcall } from '../netlify/functions/ccc-postcall-webhook.mjs';

// Minimal in-memory stand-in for the supabase-js query builder + the two lead RPCs.
function fakeDb() {
  const T = { ai4cc_interactions: [], ai4cc_leads: [], ai4cc_contacts: [], ai4cc_lead_activities: [], ai4cc_audit_logs: [] };
  let n = 0; const id = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
  class Q {
    constructor(t) { this.t = t; this.f = []; this.op = 'select'; }
    select() { if (this.op === 'select') this.op = 'select'; return this; }
    eq(k, v) { this.f.push((r) => r[k] === v); return this; }
    order() { return this; } limit(n2) { this.lim = n2; return this; }
    maybeSingle() { this.one = 'maybe'; return this; } single() { this.one = 'single'; return this; }
    insert(r) { this.op = 'insert'; this.rows = [].concat(r); return this; }
    update(p) { this.op = 'update'; this.patch = p; return this; }
    upsert(r, o) { this.op = 'upsert'; this.rows = [].concat(r); this.opts = o; return this; }
    then(res, rej) { return Promise.resolve(this.run()).then(res, rej); }
    run() {
      const t = T[this.t];
      if (this.op === 'upsert') {
        for (const r of this.rows) {
          const dup = t.find((x) => x.tenant_id === r.tenant_id && x.channel === r.channel && x.external_id === r.external_id);
          if (!dup) t.push({ id: id(), ...r });
        }
        return { data: null, error: null };
      }
      if (this.op === 'insert') { const ins = this.rows.map((r) => ({ id: id(), ...r })); t.push(...ins); return { data: this.one ? ins[0] : ins, error: null }; }
      const m = t.filter((r) => this.f.every((f) => f(r)));
      if (this.op === 'update') { m.forEach((r) => Object.assign(r, this.patch)); return { data: m, error: null }; }
      const out = this.lim ? m.slice(0, this.lim) : m;
      if (this.one) return { data: out[0] || null, error: this.one === 'single' && !out[0] ? { message: 'no rows' } : null };
      return { data: out, error: null };
    }
  }
  return {
    T,
    from: (t) => new Q(t),
    async rpc(name, a) {
      if (name === 'ai4cc_create_lead_from_interaction') {
        const i = T.ai4cc_interactions.find((x) => x.id === a.p_interaction_id);
        if (i.status !== 'completed') return { data: null, error: { message: 'AI4CC_INTERACTION_NOT_COMPLETED' } };
        const contact = { id: id(), tenant_id: a.p_tenant_id, display_name: a.p_contact_name, phone: a.p_phone, email: a.p_email, idType: a.p_identifier_type };
        T.ai4cc_contacts.push(contact);
        const lead = { id: id(), tenant_id: a.p_tenant_id, contact_id: contact.id, originating_interaction_id: i.id, title: a.p_title, service_interest: a.p_service_interest, pipeline_stage: a.p_pipeline_stage, description: a.p_description };
        T.ai4cc_leads.push(lead);
        return { data: { lead }, error: null };
      }
      if (name === 'ai4cc_record_lead_activity') { T.ai4cc_lead_activities.push({ id: id(), lead_id: a.p_lead_id, type: a.p_activity_type, body: a.p_body }); return { data: {}, error: null }; }
      return { data: null, error: { message: 'unknown rpc' } };
    },
  };
}

const SECRET = 'ccc-test-secret';
const post = async (body, headers = { 'x-intake-secret': SECRET }) => {
  const r = await handler({ httpMethod: 'POST', headers, body: JSON.stringify(body) });
  return [r.statusCode, JSON.parse(r.body)];
};

let F;
beforeEach(() => { F = fakeDb(); setDbForTests(F); process.env.CCC_INTAKE_WEBHOOK_SECRET = SECRET; delete process.env.INTAKE_WEBHOOK_SECRET; delete process.env.SALES_INTAKE_WEBHOOK_SECRET; delete process.env.RESEND_API_KEY; });

test('initiate returns caller_number dynamic variable', async () => {
  const [s, b] = await post({ caller_id: '(702) 555-1234', call_sid: 'CA1', agent_id: 'x' });
  assert.equal(s, 200);
  assert.equal(b.type, 'conversation_initiation_client_data');
  assert.equal(b.dynamic_variables.caller_number, '+17025551234');
});

test('start opens one interaction per conversation and returns interactionId', async () => {
  const [s, b] = await post({ action: 'start', callerPhone: '+17025551234', conversationId: 'conv_1' });
  assert.equal(s, 200); assert.ok(b.interactionId); assert.equal(b.transferAllowed, 'no');
  const [, b2] = await post({ action: 'start', callerPhone: '+17025551234', conversationId: 'conv_1' });
  assert.equal(b2.interactionId, b.interactionId);
  assert.equal(F.T.ai4cc_interactions.length, 1);
  assert.equal(F.T.ai4cc_interactions[0].metadata.source, 'customer_care_center_voice');
});

test('start tolerates an unresolved {{caller_number}} placeholder', async () => {
  const [s, b] = await post({ action: 'start', callerPhone: '{{caller_number}}', conversationId: 'conv_2' });
  assert.equal(s, 200); assert.ok(b.interactionId);
  assert.equal(F.T.ai4cc_interactions[0].metadata.phone, null);
});

test('submit creates a lead in the pipeline and completes the interaction', async () => {
  const [, st] = await post({ action: 'start', callerPhone: '+17025551234', conversationId: 'conv_3' });
  const [s, b] = await post({ action: 'submit', interactionId: st.interactionId, callerName: 'Ana Ruiz, Owner', businessName: 'Ruiz HVAC', email: 'ANA@ruizhvac.com', serviceInterest: 'Customer Engagement Operations Center', description: 'Misses calls after 5pm.' });
  assert.equal(s, 200); assert.equal(b.ok, true); assert.equal(b.updated, false);
  assert.equal(F.T.ai4cc_leads.length, 1);
  assert.equal(F.T.ai4cc_leads[0].pipeline_stage, 'new');
  assert.equal(F.T.ai4cc_contacts[0].email, 'ana@ruizhvac.com');
  assert.equal(F.T.ai4cc_contacts[0].phone, '+17025551234', 'falls back to the phone from start_session');
  assert.equal(F.T.ai4cc_interactions[0].status, 'completed');
  assert.ok(F.T.ai4cc_lead_activities.some((a) => a.type === 'voice_call'));
});

test('a second submit in the same call updates instead of duplicating', async () => {
  const [, st] = await post({ action: 'start', conversationId: 'conv_4' });
  await post({ action: 'submit', interactionId: st.interactionId, callerName: 'Bo', businessName: 'Bo Co', serviceInterest: 'PMA' });
  const [, b] = await post({ action: 'submit', interactionId: st.interactionId, callerName: 'Bo', businessName: 'Bo Co', serviceInterest: 'Support Specialist' });
  assert.equal(b.updated, true);
  assert.equal(F.T.ai4cc_leads.length, 1);
  assert.equal(F.T.ai4cc_leads[0].service_interest, 'Support Specialist');
});

test('not-interested calls are kept as nurture leads', async () => {
  const [, st] = await post({ action: 'start', conversationId: 'conv_5' });
  await post({ action: 'submit', interactionId: st.interactionId, callerName: 'Cy', businessName: 'Cy LLC', serviceInterest: 'Not interested' });
  assert.equal(F.T.ai4cc_leads[0].pipeline_stage, 'nurture');
});

test('missing name or business tells the agent what to ask for', async () => {
  const [, st] = await post({ action: 'start', conversationId: 'conv_6' });
  const [s, b] = await post({ action: 'submit', interactionId: st.interactionId, callerName: '' });
  assert.equal(s, 200); assert.equal(b.ok, false); assert.deepEqual(b.missing, ['callerName', 'businessName']);
  assert.equal(F.T.ai4cc_leads.length, 0);
});

test('bad or foreign interactionId is rejected without writing', async () => {
  const [, b] = await post({ action: 'submit', interactionId: 'abc', callerName: 'x', businessName: 'y' });
  assert.equal(b.error, 'MISSING_INTERACTION_ID');
  F.T.ai4cc_interactions.push({ id: '11111111-1111-4111-8111-111111111111', tenant_id: TENANT_ID, metadata: { source: 'other' } });
  const [, b2] = await post({ action: 'submit', interactionId: '11111111-1111-4111-8111-111111111111', callerName: 'x', businessName: 'y' });
  assert.equal(b2.error, 'UNKNOWN_INTERACTION');
});

test('submit without start_session opens the interaction from the conversation id', async () => {
  const [s, b] = await post({ action: 'submit', interactionId: '', conversationId: 'conv_skip', callerPhone: '+17025559876', callerName: 'Di Lopez, Owner', businessName: 'Lopez Plumbing', email: 'di@lopezplumbing.com', serviceInterest: 'Support Specialist' });
  assert.equal(s, 200); assert.equal(b.ok, true);
  assert.equal(F.T.ai4cc_interactions.length, 1);
  assert.equal(F.T.ai4cc_interactions[0].external_id, 'conv_skip');
  assert.equal(F.T.ai4cc_interactions[0].status, 'completed');
  assert.equal(F.T.ai4cc_leads.length, 1);
  const [, again] = await post({ action: 'submit', interactionId: '{{interactionId}}', conversationId: 'conv_skip', callerName: 'Di Lopez, Owner', businessName: 'Lopez Plumbing', serviceInterest: 'PMA' });
  assert.equal(again.updated, true, 'a repeat submit in the same conversation updates the same lead');
  assert.equal(F.T.ai4cc_interactions.length, 1); assert.equal(F.T.ai4cc_leads.length, 1);
});

test('synthetic checks use an opaque identifier', async () => {
  const [, st] = await post({ action: 'start', callerPhone: '+10000000000', conversationId: 'synthetic_check_1' });
  await post({ action: 'submit', interactionId: st.interactionId, callerName: 'Synthetic', businessName: 'Synthetic', email: 'x@y.com' });
  assert.equal(F.T.ai4cc_contacts[0].idType, 'opaque');
  assert.equal(F.T.ai4cc_interactions[0].metadata.synthetic, true);
});

test('every request needs the CCC secret; unset secret refuses all', async () => {
  const [s1] = await post({ action: 'start', conversationId: 'c' }, {});
  assert.equal(s1, 401);
  const [s2] = await post({ action: 'start', conversationId: 'c' }, { 'x-intake-secret': 'wrong' });
  assert.equal(s2, 401);
  process.env.SALES_INTAKE_WEBHOOK_SECRET = SECRET; process.env.INTAKE_WEBHOOK_SECRET = SECRET;
  delete process.env.CCC_INTAKE_WEBHOOK_SECRET;
  const [s3] = await post({ action: 'start', conversationId: 'c' });
  assert.equal(s3, 401, 'Sales secrets are not accepted on the CCC webhook');
  assert.equal(F.T.ai4cc_interactions.length, 0);
});

test('CCC secret is trimmed and tagged as Customer Care Center', async () => {
  process.env.CCC_INTAKE_WEBHOOK_SECRET = ' ' + SECRET + '\n';
  const [s, b] = await post({ action: 'start', conversationId: 'c2' });
  assert.equal(s, 200); assert.ok(b.interactionId);
  assert.equal(F.T.ai4cc_interactions[0].metadata.source, 'customer_care_center_voice');
  assert.equal(F.T.ai4cc_interactions[0].metadata.product, 'Customer Care Center');
});

test('unknown action and bad JSON are rejected', async () => {
  const [s] = await post({ action: 'drop_tables' });
  assert.equal(s, 400);
  const r = await handler({ httpMethod: 'POST', headers: { 'x-intake-secret': SECRET }, body: '{nope' });
  assert.equal(r.statusCode, 400);
  const g = await handler({ httpMethod: 'GET', headers: {} });
  assert.equal(g.statusCode, 405);
});

test('postcall rejects unsigned requests and logs signed ones', async () => {
  delete process.env.ELEVENLABS_POSTCALL_SECRET;
  let r = await postcall({ httpMethod: 'POST', headers: {}, body: '{}' });
  assert.equal(r.statusCode, 401);
  process.env.ELEVENLABS_POSTCALL_SECRET = 'whsec_test_123';
  const [, st] = await post({ action: 'start', conversationId: 'conv_pc' });
  await post({ action: 'submit', interactionId: st.interactionId, callerName: 'D', businessName: 'D Co', serviceInterest: 'PMA' });
  const raw = JSON.stringify({ data: { conversation_id: 'conv_pc', metadata: { call_duration_secs: 95 }, analysis: { call_successful: 'success', transcript_summary: 'Caller wants PMA.' } } });
  const ts = Math.floor(Date.now() / 1000);
  const sig = `t=${ts},v0=${createHmac('sha256', 'whsec_test_123').update(`${ts}.${raw}`).digest('hex')}`;
  r = await postcall({ httpMethod: 'POST', headers: { 'elevenlabs-signature': sig }, body: raw });
  assert.equal(r.statusCode, 200);
  assert.equal(F.T.ai4cc_interactions[0].metadata.postcall.durationSecs, 95);
  assert.ok(F.T.ai4cc_lead_activities.some((a) => a.type === 'call_summary'));
  r = await postcall({ httpMethod: 'POST', headers: { 'elevenlabs-signature': sig.replace(/.$/, '0') }, body: raw });
  assert.equal(r.statusCode, 401);
});
