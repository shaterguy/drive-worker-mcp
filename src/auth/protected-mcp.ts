import { requireMcpAuth } from '@better-auth/mcp';
import { createResourceServerChallenge } from '@better-auth/oauth-provider';
import { APIError } from 'better-auth/api';
import { createInsufficientScopeError } from 'better-auth/oauth2';
import type { DriveWorkerAuth } from './better-auth.ts';
import type { PostgresAuthAuthority } from './authority.ts';
import type { Principal } from '../contracts.ts';
import { TOOL_REQUIRED_SCOPE } from '../mcp.ts';
import { AuthBoundaryError, TOOL_SCOPES, type AuthConfig } from './config.ts';
import { assertRequestOrigin, boundedRequest, noStore } from './request-guards.ts';

export function protectMcpRoute(auth: DriveWorkerAuth, config: AuthConfig, authority: PostgresAuthAuthority,
  execute: (request: Request, principal: Principal) => Promise<Response>) {
  const authenticated = requireMcpAuth(auth, async (request, claims) => {
    const principal = await authority.principalFromVerifiedClaims(claims);
    let message: unknown;
    try { message = await request.clone().json(); } catch { /* SDK emits the protocol parse error. */ }
    const missing = new Set<string>();
    // Preflight every member if SDK compatibility mode accepts a legacy batch.
    for (const item of Array.isArray(message) ? message : [message]) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const call = item as { method?: unknown; params?: { name?: unknown } };
      if (call.method === 'tools/call' && typeof call.params?.name === 'string') {
        const required = TOOL_REQUIRED_SCOPE[call.params.name];
        if (required && !principal.scopes.has(required)) missing.add(required);
      }
    }
    if (missing.size) throw createInsufficientScopeError([...missing]);
    return execute(request, principal);
  }, { issuer: config.issuer, resource: config.resource, jwksUrl: `${config.issuer}/jwks`, challengeScopes: TOOL_SCOPES });
  return async (request: Request): Promise<Response> => {
    try {
      assertRequestOrigin(request, config);
      if (request.method !== 'POST') return noStore(new Response(null, { status: 405, headers: { Allow: 'POST' } }));
      if (new URL(request.url).pathname !== '/mcp') return noStore(Response.json({ error: 'NOT_FOUND' }, { status: 404 }));
      return noStore(await authenticated(await boundedRequest(request)));
    } catch (error) {
      if (!(error instanceof AuthBoundaryError)) return noStore(Response.json({ error: 'AUTH_UNAVAILABLE' }, { status: 503 }));
      if (['INVALID_HOST','INVALID_ORIGIN','INVALID_REQUEST','REQUEST_TOO_LARGE'].includes(error.code)) {
        return noStore(Response.json({ error: error.code }, { status: error.code === 'REQUEST_TOO_LARGE' ? 413 : 400 }));
      }
      const challenge = createResourceServerChallenge(new APIError('UNAUTHORIZED', { message: 'AUTH_REQUIRED' }), config.resource,
        { challengeScopes: TOOL_SCOPES });
      if (!challenge) return noStore(Response.json({ error: 'AUTH_UNAVAILABLE' }, { status: 503 }));
      return noStore(Response.json({ error: 'AUTH_REQUIRED' }, { status: 401, headers: challenge.headers as HeadersInit }));
    }
  };
}
