import { AuthBoundaryError, GOOGLE_CALLBACK_PATH, loadAuthConfig, type AuthConfig } from './config.ts';
import { assertRequestOrigin, noStore } from './request-guards.ts';
import { beginRequestDiagnostics, type DiagnosticOptions, type PoolCounts, type RequestDiagnostics } from './request-diagnostics.ts';

export interface MountedRuntime {
  fetch(request: Request, diagnostic?: RequestDiagnostics): Promise<Response>;
  poolCounts?: () => PoolCounts;
  checkDatabase(): Promise<void>;
}
interface DeploymentOptions {
  environment: () => Readonly<Record<string, string | undefined>>;
  load: (config: AuthConfig) => Promise<MountedRuntime>;
  now?: () => number;
  diagnostics?: DiagnosticOptions;
}
const RETRY_MS = 30_000;

/** Concurrent cold starts share one attempt; failures are retriable after a bounded cooldown. */
export function createDeployment(options: DeploymentOptions) {
  const now = options.now ?? Date.now;
  let pending: Promise<MountedRuntime> | undefined;
  let mounted: MountedRuntime | undefined;
  let retryAfter = 0;
  let initializationFailure = '';
  let initialization: 'not_initialized' | 'initializing' | 'initialized' | 'unavailable' = 'not_initialized';

  async function runtime(config: AuthConfig): Promise<MountedRuntime> {
    if (mounted) return mounted;
    if (pending) return pending;
    if (now() < retryAfter) throw new AuthBoundaryError('AUTH_UNAVAILABLE');
    initialization = 'initializing';
    pending = Promise.resolve().then(() => options.load(config)).then(value => {
      mounted = value;
      initialization = 'initialized';
      return value;
    }).catch((error: unknown) => {
      initialization = 'unavailable';
      initializationFailure = error instanceof AuthBoundaryError ? error.code : 'AUTH_UNAVAILABLE';
      retryAfter = now() + RETRY_MS;
      throw new AuthBoundaryError('AUTH_UNAVAILABLE');
    }).finally(() => { pending = undefined; });
    return pending;
  }

  async function handle(request: Request, diagnostic: RequestDiagnostics | undefined): Promise<Response> {
    const path = new URL(request.url).pathname;
    const health = path === '/health';
    if (health && request.method !== 'GET') return noStore(new Response(null, { status: 405, headers: { Allow: 'GET' } }));
    if (!health && path !== '/mcp' && !path.startsWith('/api/auth/') && !path.startsWith('/.well-known/') &&
        !path.startsWith('/ui/') && !['/sign-in', '/connect', '/consent'].includes(path)) {
      return noStore(Response.json({ error: 'NOT_FOUND' }, { status: 404 }));
    }
    let configured = false;
    let database: 'not_checked' | 'schema_present' | 'unavailable' = 'not_checked';
    try {
      const config = loadAuthConfig(options.environment());
      configured = true;
      assertRequestOrigin(request, config);
      diagnostic?.markPhase('runtime_init');
      const active = await runtime(config);
      diagnostic?.setPoolReader(active.poolCounts);
      if (health) {
        try { await active.checkDatabase(); database = 'schema_present'; }
        catch { database = 'unavailable'; throw new AuthBoundaryError('AUTH_UNAVAILABLE'); }
        return noStore(Response.json({ service: 'drive-worker-mcp', status: 'alive', configured,
          runtime: initialization, database, authentication: 'verification_pending', user_ready: false,
          google_callback_path: GOOGLE_CALLBACK_PATH }));
      }
      // Preserve the maintained OAuth wrapper's 401/403 responses and challenge headers.
      return noStore(await active.fetch(request,diagnostic));
    } catch (error) {
      const code = error instanceof AuthBoundaryError ? error.code : 'AUTH_UNAVAILABLE';
      if (code === 'INVALID_HOST' || code === 'INVALID_ORIGIN') {
        return noStore(Response.json({ error: code }, { status: 400 }));
      }
      if (initialization === 'unavailable' && initializationFailure === 'AUTH_DATABASE_NOT_READY') database = 'unavailable';
      if (health) return noStore(Response.json({ service: 'drive-worker-mcp', status: 'alive', configured,
        runtime: initialization, database, authentication: 'not_ready', user_ready: false,
        google_callback_path: GOOGLE_CALLBACK_PATH }, { status: 503 }));
      return noStore(Response.json({ error: 'AUTH_NOT_READY' }, { status: 503 }));
    }
  }
  return { async fetch(request: Request): Promise<Response> {
    const diagnostic=beginRequestDiagnostics(new URL(request.url).pathname,options.diagnostics);
    let status=503;
    try { const response=await handle(request,diagnostic);status=response.status;return response; }
    finally { diagnostic?.finish(status); }
  } };
}
