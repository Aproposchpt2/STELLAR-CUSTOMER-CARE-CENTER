// ElevenLabs post-call webhook for the Customer Care Center agent. Routed at /api/ccc/postcall.
// Signed with HMAC-SHA256: set ELEVENLABS_POSTCALL_SECRET on Netlify to the secret
// ElevenLabs shows for this webhook. Until it is set, every request is rejected (401).
//
// Adds call duration, outcome and the transcript summary to the call's interaction, and
// logs the summary on the lead. Returns 200 on storage errors so ElevenLabs never
// auto-disables the webhook.

import { createHmac, timingSafeEqual } from 'crypto';
import { TENANT_ID, ACTOR_USER_ID, SOURCE, PRODUCT, db, reply } from './lib/ccc-store.mjs';

export function verifySignature(rawBody, header, secret, now = Date.now()) {
  if (typeof secret !== 'string' || secret.length < 8) throw new Error('NO_POSTCALL_SECRET');
  if (typeof header !== 'string' || !header) throw new Error('MISSING_SIG');
  const parts = {};
  for (const seg of header.split(',')) {
    const i = seg.indexOf('=');
    if (i > 0) parts[seg.slice(0, i).trim()] = seg.slice(i + 1).trim();
  }
  const { t: ts, v0: mac } = parts;
  if (!ts || !mac || !/^\d{1,12}$/.test(ts) || Math.abs(now / 1000 - Number(ts)) > 300) throw new Error('INVALID_SIG');
  const expected = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(mac);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('INVALID_SIG');
  return JSON.parse(rawBody);
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'POST only' });
  let body;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
    const h = event.headers || {};
    body = verifySignature(raw, h['elevenlabs-signature'] || h['ElevenLabs-Signature'] || '', process.env.ELEVENLABS_POSTCALL_SECRET || '');
  } catch (err) {
    console.error('[ccc-postcall] auth failed:', err.message);
    return reply(401, { error: err.message });
  }

  try {
    const data = body?.data || body;
    const conversationId = data?.conversation_id;
    if (!conversationId) return reply(200, { ok: true, skipped: 'no conversation_id' });
    const meta = data.metadata || {};
    const analysis = data.analysis || {};
    const call = {
      durationSecs: Math.round(Number(meta.call_duration_secs || 0)),
      callSuccessful: analysis.call_successful || null,
      terminationReason: meta.termination_reason || analysis.termination_reason || null,
      summary: String(analysis.transcript_summary || '').slice(0, 4000) || null,
      agentId: data.agent_id || null,
      receivedAt: new Date().toISOString(),
    };
    const startedAt = meta.start_time_unix_secs ? new Date(meta.start_time_unix_secs * 1000).toISOString() : null;
    const sb = db();

    const { data: found } = await sb.from('ai4cc_interactions').select('*')
      .eq('tenant_id', TENANT_ID).eq('channel', 'voice').eq('external_id', conversationId).maybeSingle();

    let interactionId = found?.id;
    if (found) {
      await sb.from('ai4cc_interactions').update({
        status: found.status === 'completed' ? 'completed' : 'abandoned',
        ended_at: found.ended_at || new Date().toISOString(),
        metadata: { ...found.metadata, postcall: call },
      }).eq('id', found.id);
    } else {
      // The agent never called start_session: still record that the call happened.
      const { data: ins } = await sb.from('ai4cc_interactions').insert({
        tenant_id: TENANT_ID, channel: 'voice', direction: 'inbound', external_id: conversationId,
        status: 'abandoned', started_at: startedAt || new Date().toISOString(), ended_at: new Date().toISOString(),
        metadata: { source: SOURCE, product: PRODUCT, elevenlabsConversationId: conversationId, postcall: call, noSession: true },
      }).select('id').single();
      interactionId = ins?.id;
    }

    if (interactionId && call.summary) {
      const { data: lead } = await sb.from('ai4cc_leads').select('id')
        .eq('tenant_id', TENANT_ID).eq('originating_interaction_id', interactionId).maybeSingle();
      if (lead) {
        await sb.rpc('ai4cc_record_lead_activity', {
          p_tenant_id: TENANT_ID, p_actor_user_id: ACTOR_USER_ID, p_lead_id: lead.id,
          p_activity_type: 'call_summary', p_direction: 'inbound',
          p_subject: `Call summary (${call.durationSecs}s, ${call.callSuccessful || 'unknown'})`,
          p_body: call.summary, p_outcome: call.callSuccessful,
        });
      }
    }
    console.log(JSON.stringify({ event: 'ccc_postcall', conversationId, interactionId, durationSecs: call.durationSecs }));
    return reply(200, { ok: true });
  } catch (err) {
    console.error('[ccc-postcall] store error:', err.message);
    return reply(200, { ok: false, error: 'LOG_FAILED' });
  }
};
