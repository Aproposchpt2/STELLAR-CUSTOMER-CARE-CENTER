// Scheduled daily 13:17 UTC (early morning Las Vegas): this site's backend checks.
// Hands off to the background function so the 30 s scheduled-function limit never applies.
export default async () => {
  const base = String(process.env.URL || '').replace(/\/+$/, '');
  const res = await fetch(`${base}/.netlify/functions/ops-run-background`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trigger: 'daily' }),
  });
  console.log('[ops-daily] dispatched, status', res.status);
};

export const config = { schedule: '17 13 * * *' };
