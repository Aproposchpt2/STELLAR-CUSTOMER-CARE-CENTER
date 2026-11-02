// Background function: this site's stress test (25 concurrent synthetic calls, then a
// database count check and full cleanup). On demand only, from the testing panel.
import { runStress } from './lib/ops-runner.mjs';

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { /* defaults */ }
  const trigger = typeof body.trigger === 'string' && /^(manual|admin:[^\s]{3,100})$/.test(body.trigger) ? body.trigger : 'manual';
  try {
    console.log('[ops-stress]', JSON.stringify(await runStress(trigger)));
  } catch (err) {
    console.error('[ops-stress] failed:', err.message);
  }
  return { statusCode: 202 };
};
