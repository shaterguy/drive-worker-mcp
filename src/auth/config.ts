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

export interface OwnerFolderPrefill {
  readonly issuer: typeof GOOGLE_ISSUER; readonly sub: string;
  readonly manualFolderId: string; readonly commandsFolderId: string; readonly resultsFolderId: string;
}

export interface AuthConfig {
  origin: string; issuer: string; resource: string; googleCallback: string;
  databaseUrl: string; secret: string; googleClientId: string; googleClientSecret: string;
  readonly ownerPrefill?: OwnerFolderPrefill;
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
  const ownerPrefill = parseOwnerFolderPrefill(env.DWMCP_OWNER_PREFILL_JSON);
  return Object.freeze({
    ...(ownerPrefill ? { ownerPrefill } : {}),
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

/** Private operator setting. No defaults, account guessing, partial configuration, or value logging. */
export function parseOwnerFolderPrefill(value: string | undefined): OwnerFolderPrefill | undefined {
  if (value === undefined) return undefined;
  const invalid = () => new AuthBoundaryError('OWNER_PREFILL_CONFIGURATION_INVALID');
  if (!value || Buffer.byteLength(value) > 4096) throw invalid();
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw invalid(); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid();
  const input = parsed as Record<string, unknown>;
  const fields = ['issuer','sub','manualFolderId','commandsFolderId','resultsFolderId'];
  if (Object.keys(input).length !== fields.length || !fields.every(key => Object.hasOwn(input,key))) throw invalid();
  if (input.issuer !== GOOGLE_ISSUER || typeof input.sub !== 'string' || !input.sub ||
      input.sub.length > 255 || /\s|[\u0000-\u001f]/.test(input.sub)) throw invalid();
  const { manualFolderId, commandsFolderId, resultsFolderId } = input;
  if (typeof manualFolderId !== 'string' || typeof commandsFolderId !== 'string' || typeof resultsFolderId !== 'string' ||
      ![manualFolderId,commandsFolderId,resultsFolderId].every(id => /^[A-Za-z0-9_-]{1,256}$/.test(id)) ||
      new Set([manualFolderId,commandsFolderId,resultsFolderId]).size !== 3) throw invalid();
  return Object.freeze({issuer:GOOGLE_ISSUER,sub:input.sub,manualFolderId,commandsFolderId,resultsFolderId});
}
