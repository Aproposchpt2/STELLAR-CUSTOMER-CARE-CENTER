// Background function: runs this site's backend checks (15 min budget). Started by the
// testing panel and by ops-daily. Netlify replies 202 at once; results land in
// ops_check_runs / ops_test_runs. A 30 s per-product cooldown blocks repeat spam.
import { runBackendChecks } from './lib/ops-runner.mjs';

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { /* defaults */ }
  const trigger = typeof body.trigger === 'string' && /^(manual|daily|admin:[^\s]{3,100})$/.test(body.trigger) ? body.trigger : 'manual';
  try {
    console.log('[ops-run]', JSON.stringify(await runBackendChecks(trigger)));
  } catch (err) {
    console.error('[ops-run] failed:', err.message);
  }
  return { statusCode: 202 };
};
