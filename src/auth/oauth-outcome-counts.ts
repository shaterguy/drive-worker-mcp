import type { Pool } from 'pg';

export type OAuthOperation = 'code' | 'refresh' | 'revoke';
export type OAuthOutcomeWriter = (operation: OAuthOperation, status: number) => Promise<void>;

const UPSERT = `
  INSERT INTO dw_mcp_oauth_hourly_counts AS c (utc_hour, operation, http_status, occurrences)
  VALUES ($1, $2, $3, 1)
  ON CONFLICT (hour_slot, operation, http_status) DO UPDATE SET
    utc_hour = EXCLUDED.utc_hour,
    occurrences = CASE WHEN c.utc_hour = EXCLUDED.utc_hour
      THEN LEAST(c.occurrences::bigint + 1, 2147483647)::integer ELSE 1 END
  WHERE c.utc_hour <= EXCLUDED.utc_hour`;

// At most one query runs on the shared pool, with a short queue for simultaneous failures.
export function createOAuthOutcomeWriter(
  pool: Pick<Pool,'query' | 'totalCount' | 'idleCount' | 'waitingCount'>,
): OAuthOutcomeWriter {
  let pending = 0;
  let tail: Promise<void> = Promise.resolve();
  return async (operation, status) => {
    if (!['code','refresh','revoke'].includes(operation) || !Number.isInteger(status) ||
      status < 200 || status > 599 || (operation !== 'revoke' && status < 400) || pending >= 16) return;
    const utcHour = Math.floor(Date.now() / 3_600_000);
    const deadline = performance.now() + 100;
    pending++;
    tail = tail.then(async () => {
      try {
        if (performance.now() >= deadline || pool.waitingCount > 0 ||
          (pool.idleCount === 0 && pool.totalCount >= 2)) return;
        await pool.query(UPSERT,[utcHour,operation,status]);
      } catch { /* The OAuth result remains authoritative if telemetry is unavailable. */ }
      finally { pending--; }
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Most writes finish before the response. A delayed database cannot hold an auth response.
      await Promise.race([tail,new Promise<void>(resolve => { timer = setTimeout(resolve,100); })]);
    } finally { clearTimeout(timer); }
  };
}
