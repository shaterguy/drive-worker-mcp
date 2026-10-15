export const AUTH_BASE_PATH = '/api/auth';
export const GOOGLE_CALLBACK_PATH = `${AUTH_BASE_PATH}/callback/google`;
export const MCP_PATH = '/mcp';
export const GOOGLE_ISSUER = 'https://accounts.google.com';
export const TOOL_SCOPES = ['manual:publish', 'jobs:submit', 'jobs:read'] as const;
export const OAUTH_SCOPES = ['openid', 'offline_access', ...TOOL_SCOPES] as const;
export const GOOGLE_SCOPES = [
  'openid', 'email',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/drive.readonly',
] as const;

export class AuthBoundaryError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = 'AuthBoundaryError'; this.code = code; }
}

export interface AuthConfig {
  origin: string; issuer: string; resource: string; googleCallback: string;
  databaseUrl: string; secret: string; googleClientId: string; googleClientSecret: string;
}

/** Accept only an operator-set, verified deployment origin. Never infer it from a request. */
export function parsePublicOrigin(value: string | undefined): string {
  if (!value) throw new AuthBoundaryError('AUTH_CONFIGURATION_REQUIRED');
  let url: URL;
  try { url = new URL(value); } catch { throw new AuthBoundaryError('AUTH_CONFIGURATION_INVALID'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      url.pathname !== '/' || url.port || url.hostname === 'localhost' ||
      !url.hostname.includes('.') || url.hostname.endsWith('.localhost') ||
      url.hostname.endsWith('.local') || url.hostname.includes('*') ||
      /^(?:\d+\.){3}\d+$/.test(url.hostname) || url.hostname.includes(':')) {
    throw new AuthBoundaryError('AUTH_CONFIGURATION_INVALID');
  }
  return url.origin;
}

export function loadAuthConfig(env: Readonly<Record<string, string | undefined>>): AuthConfig {
  const origin = parsePublicOrigin(env.DWMCP_PUBLIC_ORIGIN);
  const required = (key: string): string => {
    const value = env[key];
    if (!value || value.trim() !== value) throw new AuthBoundaryError('AUTH_CONFIGURATION_REQUIRED');
    return value;
  };
  const databaseUrl = required('DATABASE_URL');
  let database: URL;
  try { database = new URL(databaseUrl); } catch { throw new AuthBoundaryError('AUTH_CONFIGURATION_INVALID'); }
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || !database.hostname ||
      !['require', 'verify-full'].includes(database.searchParams.get('sslmode') ?? '')) {
    throw new AuthBoundaryError('AUTH_CONFIGURATION_INVALID');
  }
  const secret = required('BETTER_AUTH_SECRET');
  if (Buffer.byteLength(secret) < 32 || /^(change|example|replace|your[-_])/i.test(secret)) {
    throw new AuthBoundaryError('AUTH_CONFIGURATION_INVALID');
  }
  return Object.freeze({
    origin, issuer: `${origin}${AUTH_BASE_PATH}`, resource: `${origin}${MCP_PATH}`,
    googleCallback: `${origin}${GOOGLE_CALLBACK_PATH}`, databaseUrl, secret,
    googleClientId: required('GOOGLE_CLIENT_ID'), googleClientSecret: required('GOOGLE_CLIENT_SECRET'),
  });
}

/** Google's two documented issuer spellings represent one verified identity namespace. */
export function canonicalGoogleIdentity(issuer: unknown, sub: unknown): { issuer: string; sub: string } {
  if (![GOOGLE_ISSUER, 'accounts.google.com'].includes(String(issuer)) ||
      typeof sub !== 'string' || !sub || sub.length > 255 || /\s|[\u0000-\u001f]/.test(sub)) {
    throw new AuthBoundaryError('GOOGLE_IDENTITY_INVALID');
  }
  return { issuer: GOOGLE_ISSUER, sub };
}
