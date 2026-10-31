// Shared helpers for the Customer Care Center webhooks. Calls and leads go into the
// Apropos Group Lead Management pipeline (ai4cc_interactions -> ai4cc_leads), the
// same tenant and RPCs used by stellaruc.com and the PMA site intake.

import { createClient } from '@supabase/supabase-js';
import { timingSafeEqual } from 'crypto';

export const TENANT_ID = process.env.AI4CC_LEAD_TENANT_ID || '5885a020-d363-4c27-910a-c035eda132f5';
export const ACTOR_USER_ID = process.env.AI4CC_INTAKE_FALLBACK_ACTOR_ID || '735fc481-1b75-4cf3-9f68-128e9e169fdc';
export const SOURCE = 'customer_care_center_voice';
export const PRODUCT = 'Customer Care Center';
export const SYNTHETIC_PREFIX = 'synthetic_check_';
const DEFAULT_SUPABASE_URL = 'https://vqrqyanqsiqzsmlhytaz.supabase.co';

// Describes what kind of value an env var holds without revealing it (for error reasons).
function shape(v) {
  const s = String(v || '').trim();
  if (!s) return 'empty';
  if (/^https?:\/\//i.test(s)) return 'url';
  if (/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(s)) return 'jwt';
  if (/^sb_secret_/.test(s)) return 'sb_secret';
  if (/^sb_publishable_/.test(s)) return 'sb_publishable';
  return `other(len ${s.length})`;
}
export let envShape = null;
let _db = null;
export function db() {
  if (_db) return _db;
  // The project URL is public (it's in the site's pages), so a malformed env value
  // falls back to it rather than taking the agent's tools down. The key has no fallback.
  const clean = (v) => String(v || '').trim().replace(/^["']|["']$/g, '');
  let rawUrl = clean(process.env.SUPABASE_URL).replace(/\/+$/, '');
  let key = clean(process.env.SUPABASE_SERVICE_ROLE_KEY);
  // The two values pasted into each other's fields: swap them back.
  if (/^https?:\/\//i.test(key) && rawUrl && !/^https?:\/\//i.test(rawUrl)) {
    console.warn('[ccc-store] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY look swapped; using them the other way round');
    [rawUrl, key] = [key.replace(/\/+$/, ''), rawUrl];
  }
  const url = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(rawUrl) ? rawUrl : DEFAULT_SUPABASE_URL;
  if (rawUrl && url !== rawUrl) console.warn('[ccc-store] SUPABASE_URL is not a valid project URL; using the default project');
  if (!key) throw new Error('SUPABASE_NOT_CONFIGURED');
  envShape = { url: shape(process.env.SUPABASE_URL), key: shape(process.env.SUPABASE_SERVICE_ROLE_KEY) };
  _db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return _db;
}
export function setDbForTests(client) { _db = client; }

export const HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
export const reply = (statusCode, body) => ({ statusCode, headers: HEADERS, body: JSON.stringify(body) });

// Trimmed string; drops unresolved ElevenLabs placeholders like "{{caller_number}}".
export function text(v, max = 500) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  if (!s || /^\{\{.*\}\}$/.test(s) || s.toLowerCase() === 'unknown') return '';
  return s.slice(0, max);
}

export function normalizePhone(value) {
  const raw = text(value, 40);
  if (!raw || !/^[+\d().\-\s]+$/.test(raw)) return null;
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  if (raw.startsWith('+')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return digits;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export function normalizeEmail(value) {
  const e = text(value, 200).toLowerCase().replace(/\s+/g, '');
  return EMAIL_RE.test(e) ? e : null;
}

export const isUuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

// Shared secret: the agent's tools must send CCC_INTAKE_WEBHOOK_SECRET in the
// x-intake-secret header (ElevenLabs workspace secret ccc_intake_key). Without it
// the webhook refuses every call, so nobody else can write CCC leads.
export function secretOk(headers = {}) {
  const clean = (v) => String(v || '').trim().replace(/^["']|["']$/g, '');
  const secret = clean(process.env.CCC_INTAKE_WEBHOOK_SECRET);
  if (!secret) return false;
  const got = String(headers['x-intake-secret'] || headers['X-Intake-Secret'] || '').trim();
  const a = Buffer.from(got), b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Best-effort per-IP limiter (per function instance).
const _rl = new Map();
export function allow(key, max = 120, windowMs = 60_000) {
  const now = Date.now();
  const e = _rl.get(key);
  if (!e || e.r <= now) { _rl.set(key, { c: 1, r: now + windowMs }); return true; }
  if (e.c >= max) return false;
  e.c++; return true;
}
export const clientIp = (headers = {}) =>
  String(headers['x-nf-client-connection-ip'] || headers['x-forwarded-for'] || 'unknown').split(',')[0].trim();
