// ElevenLabs webhook for the Customer Care Center demo agent (Jordan). Routed at /api/ccc/intake.
//
//   initiate  conversation-initiation webhook (no action field; has caller_id/call_sid).
//             Returns dynamic variables: caller_number, known_caller_name.
//   start     start_session tool: {action:"start", callerPhone, conversationId}
//             Opens a voice interaction. Returns {interactionId, transferAllowed}.
//   submit    submit_lead tool: {action:"submit", interactionId, businessName?, callerName,
//             (callers are the demo business's customers, so businessName is optional and
//             defaults to the business they called; serviceInterest is the request type)
//             email, phone, serviceInterest, description, conversationId, callerPhone}
//             If start_session was skipped, conversationId opens the interaction here.
//             Completes the interaction and creates the lead (or updates it on a repeat
//             submit in the same call). Emails the owner for new leads.
//
// Errors the agent can act on come back as 200 {ok:false, error, missing?} so the agent
// can ask the caller again instead of failing the tool call.

import { envShape,
  TENANT_ID, ACTOR_USER_ID, SOURCE, PRODUCT, SYNTHETIC_PREFIX,
  db, reply, text, normalizePhone, normalizeEmail, isUuid, secretOk, allow, clientIp,
} from './lib/ccc-store.mjs';

// Lead title by request type, e.g. "Appointment request: title transfer". Categories are
// generic customer-care types (any service or product business); the live demo business is
// Stellar Registration & Title Services. Order matters: the first match wins.
const REQUEST_TYPES = [
  ['Urgent request', /\b(urgent|emergency|asap|right away|immediately|today|expired|impound\w*|stranded|can'?t drive)\b/i],
  ['Complaint', /\b(complain\w*|unhappy|dissatisfied|refund|mistake|error on|wrong|delay\w*)\b/i],
  ['Dealer or fleet request', /\b(dealer\w*|fleet|bulk|multiple vehicles|\d+ (trucks|vehicles|cars))\b/i],
  ['Mobile VIN inspection', /\b(vin (inspection|verification|check)|mobile (inspection|inspector)|come to (my|our))\b/i],
  ['Appointment request', /\b(appointment|schedul\w*|book(ing)?|reschedul\w*|cancel\w*|come in|drop.?off)\b/i],
  ['Quote request', /\b(quote|estimate|pric(e|es|ing)|cost|how much|fee)\b/i],
  ['Status update', /\b(status|ready|update on|follow.?up|pick.?up|where is|done yet)\b/i],
  ['Document checklist', /\b(what do i need|documents?|paperwork|checklist|requirements?|bring)\b/i],
  ['Question', /\b(question|hours|open|location|address|do you|information|info)\b/i],
];
export function requestType(interest, description) {
  const text = `${interest || ''} ${description || ''}`;
  return (REQUEST_TYPES.find(([, re]) => re.test(text)) || ['Service request'])[0];
}
export function leadTitle(interest, description) {
  const type = requestType(interest, description);
  const what = String(interest || '').replace(/^\s*(appointment request|quote request|service request)\s*[-:–—]\s*/i, '').trim();
  return `${type}: ${what || 'Customer Care Center call'}`.slice(0, 160);
}

const TRANSFER_ALLOWED = (process.env.SS_TRANSFER_ALLOWED || 'no').toLowerCase() === 'yes' ? 'yes' : 'no';
const NOTIFY_EMAIL = 'jmitchell@aproposgroupllc.com';
// Fictional business the CCC agent answers for (Stellar Registration & Title Services demo).
const DEMO_BUSINESS = process.env.CCC_DEMO_BUSINESS || 'Stellar Registration & Title Services (customer)';
const NOT_INTERESTED = /^(not interested|none|no interest|n\/a)$/i;

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'POST only' });
  const headers = event.headers || {};
  if (!secretOk(headers)) return reply(401, { error: 'UNAUTHORIZED' });
  if (!allow(clientIp(headers), 300)) return reply(429, { error: 'RATE_LIMITED' });

  let body;
  try {
    body = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString() : (event.body || '{}'));
  } catch { return reply(400, { error: 'INVALID_JSON' }); }
  if (!body || typeof body !== 'object') return reply(400, { error: 'INVALID_BODY' });

  const action = body.action || event.queryStringParameters?.action
    || ((body.caller_id !== undefined || body.call_sid !== undefined) ? 'initiate' : '');

  try {
    if (action === 'initiate') return await initiate(body);
    if (action === 'start') return await start(body);
    if (action === 'submit') return await submit(body);
    return reply(400, { error: 'UNKNOWN_ACTION', action: String(action).slice(0, 40) });
  } catch (err) {
    console.error(JSON.stringify({ event: 'ccc_intake_error', action, error: err?.message }));
    // Short, secret-free reason so tool logs and the ops checks show what broke.
    const reason = err?.message === 'SUPABASE_NOT_CONFIGURED' ? 'SUPABASE_NOT_CONFIGURED' : String(err?.message || '').slice(0, 160);
    const config = /api key|supabaseUrl/i.test(reason) ? envShape : undefined;
    return reply(200, { ok: false, error: 'SERVER_ERROR', reason, ...(config ? { config } : {}) });
  }
};

async function initiate(body) {
  const phone = normalizePhone(body.caller_id || body.callerPhone || body.from);
  let knownName = '';
  if (phone) {
    const { data } = await db().from('ai4cc_contacts').select('display_name')
      .eq('tenant_id', TENANT_ID).eq('phone', phone).order('created_at', { ascending: false }).limit(1);
    knownName = data?.[0]?.display_name || '';
  }
  return reply(200, {
    type: 'conversation_initiation_client_data',
    dynamic_variables: { caller_number: phone || 'unknown', known_caller_name: knownName },
  });
}

// Opens (or reuses) the voice interaction for this conversation. Idempotent per
// conversation: a repeated start_session reuses the same interaction.
async function ensureInteraction({ conversationId, phone }) {
  const externalId = conversationId || `ccc_${crypto.randomUUID()}`;
  const synthetic = externalId.startsWith(SYNTHETIC_PREFIX);
  const now = new Date().toISOString();
  const sb = db();
  const { error: upErr } = await sb.from('ai4cc_interactions').upsert({
    tenant_id: TENANT_ID, channel: 'voice', direction: 'inbound', external_id: externalId,
    customer_identifier: phone, status: 'active', started_at: now,
    metadata: {
      source: SOURCE, product: PRODUCT, agentName: 'STELLAR Customer Care Center (Jordan)',
      phone, elevenlabsConversationId: conversationId || null, ...(synthetic ? { synthetic: true } : {}),
    },
  }, { onConflict: 'tenant_id,channel,external_id', ignoreDuplicates: true });
  if (upErr) throw new Error(`interaction upsert: ${upErr.message}`);

  const { data, error } = await sb.from('ai4cc_interactions').select('id')
    .eq('tenant_id', TENANT_ID).eq('channel', 'voice').eq('external_id', externalId).single();
  if (error) throw new Error(`interaction read: ${error.message}`);
  return data.id;
}

async function start(body) {
  const conversationId = text(body.conversationId || body.conversation_id, 120);
  const phone = normalizePhone(body.callerPhone || body.caller_phone);
  const interactionId = await ensureInteraction({ conversationId, phone });
  console.log(JSON.stringify({ event: 'ccc_session_started', interactionId, conversationId }));
  return reply(200, { ok: true, interactionId, transferAllowed: TRANSFER_ALLOWED });
}

async function submit(body) {
  let interactionId = text(body.interactionId, 60);
  const callerName = text(body.callerName, 200);
  const businessName = text(body.businessName, 200) || DEMO_BUSINESS;
  const email = normalizeEmail(body.email);
  const serviceInterest = text(body.serviceInterest, 300);
  const description = text(body.description, 4000);

  const missing = [!callerName && 'callerName'].filter(Boolean);
  if (missing.length) return reply(200, { ok: false, error: 'MISSING_FIELDS', missing });
  // start_session was skipped: open the interaction for this conversation now rather
  // than losing the lead. Needs the conversation id the tool sends.
  if (!isUuid(interactionId)) {
    const conversationId = text(body.conversationId || body.conversation_id, 120);
    if (!conversationId) return reply(200, { ok: false, error: 'MISSING_INTERACTION_ID', hint: 'Call start_session first and pass its interactionId.' });
    interactionId = await ensureInteraction({ conversationId, phone: normalizePhone(body.callerPhone || body.caller_phone) });
    console.log(JSON.stringify({ event: 'ccc_session_recovered', interactionId, conversationId }));
  }

  const sb = db();
  const { data: interaction, error: iErr } = await sb.from('ai4cc_interactions').select('*')
    .eq('id', interactionId).eq('tenant_id', TENANT_ID).maybeSingle();
  if (iErr) throw new Error(`interaction read: ${iErr.message}`);
  if (!interaction || interaction.metadata?.source !== SOURCE) return reply(200, { ok: false, error: 'UNKNOWN_INTERACTION' });

  const synthetic = String(interaction.external_id || '').startsWith(SYNTHETIC_PREFIX);
  const phone = normalizePhone(body.phone) || interaction.metadata?.phone || null;
  const notInterested = !serviceInterest || NOT_INTERESTED.test(serviceInterest);
  const now = new Date().toISOString();
  const fields = { callerName, businessName, email, phone, serviceInterest: serviceInterest || 'Not interested', description };

  const { error: uErr } = await sb.from('ai4cc_interactions').update({
    status: 'completed', ended_at: now,
    customer_identifier: email || phone || interaction.customer_identifier,
    metadata: { ...interaction.metadata, ...fields, submittedAt: now },
  }).eq('id', interactionId);
  if (uErr) throw new Error(`interaction update: ${uErr.message}`);

  const leadBody = [
    `Caller: ${callerName}`, `Business: ${businessName}`, `Phone: ${phone || '-'}`, `Email: ${email || '-'}`,
    `Interest: ${fields.serviceInterest}`, '', description || '(no summary)',
  ].join('\n');

  // Repeat submit in the same call (caller corrected something): update, don't duplicate.
  const { data: existing } = await sb.from('ai4cc_leads').select('id')
    .eq('tenant_id', TENANT_ID).eq('originating_interaction_id', interactionId).maybeSingle();
  if (existing) {
    await sb.from('ai4cc_leads').update({
      service_interest: fields.serviceInterest, description: description || null, updated_at: now,
    }).eq('id', existing.id);
    await activity(existing.id, 'lead_updated', 'Customer Care Center call details corrected', leadBody);
    return reply(200, { ok: true, leadId: existing.id, updated: true });
  }

  // Synthetic checks use an opaque identifier so they never attach to a real contact.
  const [idType, idValue] = synthetic ? ['opaque', interaction.external_id]
    : email ? ['email', email] : phone ? ['phone', phone] : ['opaque', interaction.external_id];

  const { data: created, error: rErr } = await sb.rpc('ai4cc_create_lead_from_interaction', {
    p_tenant_id: TENANT_ID, p_actor_user_id: ACTOR_USER_ID, p_interaction_id: interactionId,
    p_identifier_type: idType, p_identifier_value: idValue, p_email: email, p_phone: phone,
    p_contact_name: callerName, p_company_name: businessName,
    p_title: notInterested ? 'Customer Care Center call: not interested' : leadTitle(fields.serviceInterest, description),
    p_service_interest: fields.serviceInterest, p_description: description || null,
    p_pipeline_stage: notInterested ? 'nurture' : 'new', p_priority: 'normal',
    p_score: notInterested ? 20 : 60, p_estimated_value: 0, p_probability: 0,
    p_next_action: notInterested ? 'No follow-up requested. Review call summary.' : 'Follow up within one business day.',
    p_next_follow_up: notInterested ? null : new Date(Date.now() + 864e5).toISOString(),
  });
  if (rErr) throw new Error(`create lead: ${rErr.message}`);
  const leadId = created?.lead?.id || null;
  if (leadId) await activity(leadId, 'voice_call', 'Customer Care Center call', leadBody);

  if (!synthetic && !notInterested) await notifyOwner(fields).catch((e) => console.error('[ccc-intake] email failed', e.message));
  console.log(JSON.stringify({ event: 'ccc_lead_created', leadId, interactionId, notInterested }));
  return reply(200, { ok: true, leadId, updated: false });
}

async function activity(leadId, type, subject, bodyText) {
  const { error } = await db().rpc('ai4cc_record_lead_activity', {
    p_tenant_id: TENANT_ID, p_actor_user_id: ACTOR_USER_ID, p_lead_id: leadId,
    p_activity_type: type, p_direction: 'inbound', p_subject: subject, p_body: bodyText, p_outcome: null,
  });
  if (error) console.error('[ccc-intake] activity failed', error.message);
}

async function notifyOwner(f) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return;
  const from = process.env.CCC_RESEND_FROM_EMAIL || 'Stellar Intelligent Business Systems <notifications@stellaruc.com>';
  const to = process.env.OWNER_NOTIFICATION_EMAIL || process.env.RESEND_TO_EMAIL || process.env.OWNER_EMAIL || NOTIFY_EMAIL;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from, to: to.split(',').map((s) => s.trim()).filter(Boolean),
      ...(f.email ? { reply_to: f.email } : {}),
      subject: `New Customer Care Center request: ${f.serviceInterest} — ${f.callerName}`,
      text: `Jordan captured a new lead on the Customer Care Center line. It's in Lead Management.\n\n` +
        `Name: ${f.callerName}\nBusiness: ${f.businessName}\nPhone: ${f.phone || '-'}\nEmail: ${f.email || '-'}\n` +
        `Interest: ${f.serviceInterest}\n\n${f.description || ''}\n`,
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) console.error('[ccc-intake] owner email status', res.status);
}
