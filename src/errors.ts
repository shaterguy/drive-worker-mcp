const PROFILES = Object.freeze({
  GOOGLE_REAUTH_REQUIRED: { category: 'authentication', retryable: false, action: 'Reconnect Google through the normal sign-in flow.' },
  INSUFFICIENT_SCOPE: { category: 'scope', retryable: false, action: 'Review the required tool and Google scopes through the normal consent flow.' },
  DRIVE_PERMISSION_DENIED: { category: 'permission', retryable: false, action: 'Review access to the bound Drive resource.' },
  DRIVE_APP_NOT_AUTHORIZED: { category: 'app_access', retryable: false, action: 'Review this app\'s access to the bound Drive resource.' },
  DRIVE_DOMAIN_POLICY: { category: 'domain_policy', retryable: false, action: 'Ask the domain administrator to review the Drive app policy.' },
  UPSTREAM_QUOTA_EXCEEDED: { category: 'quota', retryable: false, action: 'Review the relevant Google quota or resource limit before trying again.' },
  UPSTREAM_RATE_LIMITED: { category: 'rate_limit', retryable: true, action: 'Wait before a bounded retry of the same read.' },
  UPSTREAM_FORBIDDEN_UNKNOWN: { category: 'upstream_forbidden_unknown', retryable: true,
    action: 'Retry only the same read a limited number of times. Do not reconnect or change permissions based on this error alone.' },
  UPSTREAM_UNAVAILABLE: { category: 'upstream_unavailable', retryable: true, action: 'Wait before a bounded retry of the same read.' },
  DRIVE_NOT_FOUND: { category: 'not_found', retryable: false, action: 'Check the existing job and bound Drive resource.' },
  DRIVE_FILE_EXISTS: { category: 'upstream_conflict', retryable: false, action: 'Reconcile the existing reserved Drive file.' },
  SUBMISSION_OUTCOME_UNKNOWN: { category: 'submission_unknown', retryable: false, action: 'Publication is not confirmed.' },
});
export type UpstreamErrorCode = Exclude<keyof typeof PROFILES, 'SUBMISSION_OUTCOME_UNKNOWN'>;
export interface UpstreamErrorInfo { readonly code: UpstreamErrorCode; readonly correlation_id?: string }
export const isUpstreamErrorCode = (value: unknown): value is UpstreamErrorCode => typeof value === 'string'
  && value !== 'SUBMISSION_OUTCOME_UNKNOWN' && Object.hasOwn(PROFILES, value);
export const isCorrelationId = (value: unknown): value is string => typeof value === 'string'
  && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);

export class ServiceError extends Error {
  readonly code: string;
  readonly upstream: UpstreamErrorInfo | undefined;
  constructor(code: string, upstream?: UpstreamErrorInfo) {
    super(code); this.name = 'ServiceError'; this.code = code; this.upstream = upstream;
  }
}
export function fail(code: string): never { throw new ServiceError(code); }
export function safeError(error: unknown, context: 'read' | 'publication' = 'read') {
  const code = error instanceof ServiceError ? error.code : 'INTERNAL_ERROR';
  if (!Object.hasOwn(PROFILES, code)) return { code };
  const profile = PROFILES[code as keyof typeof PROFILES];
  const publication = context === 'publication' || code === 'SUBMISSION_OUTCOME_UNKNOWN';
  const upstream = error instanceof ServiceError ? error.upstream : undefined;
  const validUpstream = upstream && isUpstreamErrorCode(upstream.code);
  const remedy = validUpstream ? PROFILES[upstream.code].action : profile.action;
  return { code, category: profile.category, retryable: publication ? false : profile.retryable,
    action: publication
      ? remedy + ' Publication is not confirmed. Check the existing job; reconcile only the identical job_id, body and route. Do not create a new job or switch routes. Use correlation_id for diagnosis when available.'
      : profile.action + ' Keep the same job. Do not submit or republish a command to resolve a read failure. Use correlation_id for diagnosis when available.',
    ...(validUpstream && upstream.code !== code ? { upstream_code: upstream.code } : {}),
    ...(validUpstream && isCorrelationId(upstream.correlation_id) ? { correlation_id: upstream.correlation_id } : {}) };
}
