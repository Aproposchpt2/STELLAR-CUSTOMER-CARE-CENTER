// Scheduled daily 13:25 UTC: runs this site's enabled agent (ElevenLabs) scripts.
// ElevenLabs finishes them on its side; ops-alert-daily settles results at 14:05 UTC
// (the testing panel also settles them whenever it polls).
import { listScripts, startAgentRuns, siteProduct } from './lib/ops-core.mjs';

export default async () => {
  const product = siteProduct();
  const scripts = (await listScripts()).filter((s) => s.product === product && s.layer === 'agent' && s.enabled !== false);
  const r = await startAgentRuns(scripts, 'daily');
  console.log('[ops-agent-daily]', JSON.stringify({ product, started: r.started.length, skipped: r.skipped.length, errors: r.errors }));
};

export const config = { schedule: '25 13 * * *' };
