const PHASES = ['boundary','runtime_init','token_verification','principal','scope_preflight','sdk_dispatch','oauth_token'] as const;
const READS = ['tenant','google_ready','grant','consent','session'] as const;
export type DiagnosticPhase = typeof PHASES[number];
export type PrincipalRead = typeof READS[number];
export interface PoolCounts { total: number; idle: number; waiting: number }
export interface DiagnosticOptions {
  now?: () => number;
  sink?: (line: string) => unknown;
}
type SafePool = { pool_total: number; pool_idle: number; pool_waiting: number };
const clamp = (value: number, maximum: number) => Math.min(maximum,Math.max(0,Math.round(value)));

/** Closed projection only. Never accepts an Error, Request, claims or arbitrary record. */
export class RequestDiagnostics {
  readonly #route: 'mcp' | 'oauth_token';
  readonly #now: () => number;
  readonly #sink: (line: string) => unknown;
  readonly #started: number;
  #phase: DiagnosticPhase = 'boundary';
  #finished = false;
  #poolReader: (() => PoolCounts) | undefined;
  #failedRead: PrincipalRead | undefined;
  #failurePool: SafePool | undefined;

  constructor(route: 'mcp' | 'oauth_token', options: DiagnosticOptions = {}) {
    this.#route = route==='oauth_token' ? 'oauth_token' : 'mcp';
    this.#now = options.now ?? (() => performance.now());
    this.#sink = options.sink ?? (line => console.info(line));
    this.#started = this.#time();
  }
  #time(): number {
    try { const value=this.#now(); return Number.isFinite(value) ? value : 0; }
    catch { return 0; }
  }
  markPhase(phase: DiagnosticPhase): void {
    if (!this.#finished && (PHASES as readonly string[]).includes(phase)) this.#phase=phase;
  }
  setPoolReader(reader: (() => PoolCounts) | undefined): void { this.#poolReader=reader; }
  #snapshot(): SafePool | undefined {
    try {
      const counts=this.#poolReader?.();
      if (!counts) return undefined;
      const {total,idle,waiting}=counts;
      if (![total,idle,waiting].every(value => typeof value==='number' && Number.isFinite(value))) return undefined;
      return {pool_total:clamp(total,65535),pool_idle:clamp(idle,65535),pool_waiting:clamp(waiting,65535)};
    } catch { return undefined; }
  }
  markPrincipalFailure(read: PrincipalRead): void {
    if (this.#finished || this.#failedRead || !(READS as readonly string[]).includes(read)) return;
    this.#failedRead=read;
    this.#failurePool=this.#snapshot();
  }
  finish(status: number): void {
    if (this.#finished) return;
    this.#finished=true;
    try {
      const http=Number.isInteger(status) && status>=100 && status<=599 ? status : 503;
      const outcome=http>=200 && http<300 ? 'http_2xx' : http>=300 && http<400 ? 'http_3xx'
        : http===401 ? 'auth_required' : http===403 ? 'forbidden' : http>=400 && http<500 ? 'request_rejected'
          : http>=500 ? 'unavailable' : 'other_http';
      const pool=this.#failedRead ? this.#failurePool : this.#snapshot();
      const line=JSON.stringify({event:'dwmcp_boundary_v1',route:this.#route,phase:this.#phase,outcome,
        http_status:http,duration_ms:clamp(this.#time()-this.#started,600000),
        ...(this.#failedRead ? {principal_read:this.#failedRead} : {}),...(pool ?? {})});
      if (Buffer.byteLength(line)>1024) return;
      // Sink failures, including an injected asynchronous sink, cannot change auth or escape as unhandled rejections.
      const result=this.#sink(line);
      if (result instanceof Promise) void result.catch(() => {});
    } catch { /* No fallback log: the original response remains authoritative. */ }
  }
}

export function beginRequestDiagnostics(pathname: string, options?: DiagnosticOptions): RequestDiagnostics | undefined {
  return pathname==='/mcp' ? new RequestDiagnostics('mcp',options)
    : pathname==='/api/auth/oauth2/token' ? new RequestDiagnostics('oauth_token',options) : undefined;
}

/** Failure label only; preserve the exact exception and every database/authorization operation. */
export async function observePrincipalRead<T>(diagnostic: RequestDiagnostics | undefined, read: PrincipalRead, operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) { diagnostic?.markPrincipalFailure(read); throw error; }
}
