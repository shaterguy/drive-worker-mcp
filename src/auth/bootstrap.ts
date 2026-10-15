import { Pool } from 'pg';
import type { AuthConfig } from './config.ts';
import { AuthBoundaryError } from './config.ts';
import type { MountedRuntime } from './deployment.ts';
import { deriveCursorKey } from './cursor-key.ts';
import { assertSchemaPresent } from './schema-readiness.ts';
import { createRuntime } from './runtime.ts';

/** Promise.race installs rejection handlers on the context, including after timeout. */
export async function awaitAuthContext(context: Promise<unknown>, timeoutMillis = 15_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([context, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new AuthBoundaryError('AUTH_UNAVAILABLE')), timeoutMillis);
    })]);
  } catch { throw new AuthBoundaryError('AUTH_UNAVAILABLE'); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

/** No environment values, database errors, or provider credentials are logged or returned. */
export async function loadRuntime(config: AuthConfig): Promise<MountedRuntime> {
  const pool = new Pool({ connectionString: config.databaseUrl, max: 3,
    connectionTimeoutMillis: 5_000, idleTimeoutMillis: 10_000, maxLifetimeSeconds: 300,
    query_timeout: 5_000, statement_timeout: 5_000, idle_in_transaction_session_timeout: 10_000,
    application_name: 'drive-worker-mcp' });
  // pg emits idle-client failures separately. It removes the failed client itself.
  pool.on('error', () => { /* Deliberately do not expose the driver's error object. */ });
  let databaseReady = false;
  try {
    await assertSchemaPresent(pool);
    databaseReady = true;
    const runtime = createRuntime(config, pool, deriveCursorKey(config));
    await awaitAuthContext(runtime.auth.$context);
    return { fetch: (request,diagnostic) => runtime.fetch(request,diagnostic), checkDatabase: () => assertSchemaPresent(pool),
      poolCounts: () => ({total:pool.totalCount,idle:pool.idleCount,waiting:pool.waitingCount}) };
  } catch {
    await pool.end().catch(() => { /* Code-only failure above; never log a DB URL. */ });
    throw new AuthBoundaryError(databaseReady ? 'AUTH_UNAVAILABLE' : 'AUTH_DATABASE_NOT_READY');
  }
}
