import type { Pool } from 'pg';
import { createAuth, accessTokenForTenant, type DriveWorkerAuth } from './better-auth.ts';
import type { RequestDiagnostics } from './request-diagnostics.ts';
import { PostgresAuthAuthority } from './authority.ts';
import { Connections } from './connections.ts';
import { createUi } from './ui.ts';
import { protectMcpRoute } from './protected-mcp.ts';
import { assertRequestOrigin, boundedRequest, noStore } from './request-guards.ts';
import { AuthBoundaryError, type AuthConfig } from './config.ts';
import { GoogleDrive } from '../google-drive.ts';
import { PostgresStore } from '../postgres-store.ts';
import { DriveWorkerService } from '../service.ts';
import { handleMcpRequest } from '../mcp.ts';
import { ServiceError } from '../errors.ts';

/** Exact external surface. Server-only auth.api helpers are never blanket-mounted. */
const AUTH_METHODS: Readonly<Record<string,readonly string[]>> = Object.freeze({
  '/api/auth/callback/google':['GET'], '/api/auth/jwks':['GET','HEAD'],
  '/api/auth/oauth2/authorize':['GET'], '/api/auth/oauth2/token':['POST'],
  '/api/auth/oauth2/revoke':['POST'], '/api/auth/oauth2/introspect':['POST'],
  '/api/auth/oauth2/userinfo':['GET','POST'],
  '/.well-known/oauth-authorization-server/api/auth':['GET','HEAD'],
  '/api/auth/.well-known/oauth-authorization-server':['GET','HEAD'],
  '/api/auth/.well-known/openid-configuration':['GET','HEAD'],
  '/.well-known/openid-configuration/api/auth':['GET','HEAD'],
  '/.well-known/oauth-protected-resource':['GET','HEAD'],
  '/.well-known/oauth-protected-resource/mcp':['GET','HEAD'],
});

/** Candidate, deliberately not invoked by the deployment scaffold. */
export function createRuntime(config: AuthConfig, pool: Pool, cursorKey: Uint8Array) {
  if (cursorKey.byteLength < 32) throw new AuthBoundaryError('AUTH_CONFIGURATION_INVALID');
  const authority = new PostgresAuthAuthority(pool,config.resource,config.issuer);
  const auth = createAuth(config,pool,authority);
  const driveForAccount = async (id: string) => new GoogleDrive({ getAccessToken:accessTokenForTenant(auth,authority,id) });
  const connections = new Connections(pool,authority,driveForAccount);
  const mcp = protectMcpRoute(auth,config,authority,async (request,principal) => {
    // No cross-request token cache. Newly refreshed access tokens join this request's redactor.
    const secrets = new Set([config.databaseUrl,config.secret,config.googleClientSecret,
      Buffer.from(cursorKey).toString('base64'),Buffer.from(cursorKey).toString('base64url'),Buffer.from(cursorKey).toString('hex')]);
    const databasePassword = decodeURIComponent(new URL(config.databaseUrl).password);
    if (databasePassword) secrets.add(databasePassword);
    const service = new DriveWorkerService({ store:new PostgresStore(pool),
      driveForAccount: async id => {
        if (id !== principal.accountId) throw new AuthBoundaryError('AUTH_REQUIRED');
        const get = accessTokenForTenant(auth,authority,id);
        return new GoogleDrive({getAccessToken:async()=>{
          try {const token=await get();secrets.add(token);return token;}
          catch {throw new ServiceError('GOOGLE_REAUTH_REQUIRED');}
        }});
      },
      assertActiveGrant: async value=>{
        try {await authority.assertActiveGrant(value);}
        catch (error) {throw new ServiceError(error instanceof AuthBoundaryError ? error.code : 'AUTH_UNAVAILABLE');}
      }, cursorKey,
      redact: value => {
        for (const secret of [...secrets].sort((a,b)=>b.length-a.length)) if (secret) {
          if (secret.length<8 && value.includes(secret)) return '[REDACTED]';
          value=value.split(secret).join('[REDACTED]');
        }
        return value;
      },
    });
    return handleMcpRequest(request,principal,service);
  });
  const ui = createUi(auth,config,connections);
  return { auth, authority, connections, fetch:createRuntimeRouter(config,{auth,ui,mcp}) };
}

/** The same router is dependency-injected for secret-free boundary fixtures. */
export function createRuntimeRouter(config: AuthConfig, handlers: {
  auth: Pick<DriveWorkerAuth,'handler'>;
  ui: (request: Request) => Promise<Response>;
  mcp: (request: Request, diagnostic?: RequestDiagnostics) => Promise<Response>;
}) {
  return async (request: Request, diagnostic?: RequestDiagnostics): Promise<Response> => {
    try {
      diagnostic?.markPhase('boundary');
      assertRequestOrigin(request,config);
      const path = new URL(request.url).pathname;
      if (path === '/health' && request.method === 'GET') return noStore(Response.json({
        service:'drive-worker-mcp', status:'alive', authentication:'candidate', user_ready:false,
      }));
      if (path === '/mcp') return handlers.mcp(request,diagnostic);
      const methods = AUTH_METHODS[path];
      if (methods) {
        if (!methods.includes(request.method)) return noStore(new Response(null,{status:405,headers:{Allow:methods.join(', ')}}));
        const bounded=await boundedRequest(request,65536);
        if (path==='/api/auth/oauth2/token') diagnostic?.markPhase('oauth_token');
        return noStore(await handlers.auth.handler(bounded));
      }
      if (['/sign-in','/connect','/consent'].includes(path) || path.startsWith('/ui/')) return noStore(await handlers.ui(request));
      return noStore(Response.json({error:'NOT_FOUND'},{status:404}));
    } catch (error) {
      const code = error instanceof AuthBoundaryError ? error.code : 'AUTH_UNAVAILABLE';
      const status = code === 'AUTH_REQUIRED' ? 401 : code === 'REQUEST_TOO_LARGE' ? 413 : code === 'AUTH_UNAVAILABLE' ? 503 : 400;
      return noStore(Response.json({error:code},{status}));
    }
  };
}
