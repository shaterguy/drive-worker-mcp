import { betterAuth } from 'better-auth';
import type { BetterAuthOptions } from 'better-auth/types';
import { genericOAuth, jwt } from 'better-auth/plugins';
import { mcp } from '@better-auth/mcp';
import { cimd } from '@better-auth/cimd';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';
import type { Pool } from 'pg';
import { AUTH_BASE_PATH, AuthBoundaryError, GOOGLE_SCOPES, OAUTH_SCOPES, type AuthConfig } from './config.ts';
import type { PostgresAuthAuthority } from './authority.ts';
import { verifiedGoogleSubject } from './google-readiness.ts';
import { accountPrivacyHooks } from './account-privacy.ts';

export interface AuthApplicationHooks {
  consentReference: PostgresAuthAuthority['consentReference'];
  issueClaims: PostgresAuthAuthority['issueClaims'];
  isBindingMissing(userId: string): Promise<boolean>;
}

/** Pure options factory shared by production and the official schema generator. No auth context starts here. */
export function createAuthOptions(config: AuthConfig, database: NonNullable<BetterAuthOptions['database']>, hooks: AuthApplicationHooks) {
  return {
    appName: 'DriveWorker MCP',
    baseURL: config.origin,
    basePath: AUTH_BASE_PATH,
    secret: config.secret,
    database,
    trustedOrigins: [config.origin],
    // Session JWTs must never be mistaken for OAuth resource access tokens.
    disabledPaths: ['/token', '/get-access-token', '/refresh-token', '/link-social', '/unlink-account'],
    emailAndPassword: { enabled: false },
    account: {
      encryptOAuthTokens: true,
      updateAccountOnSignIn: true,
      storeStateStrategy: 'database',
      storeAccountCookie: false,
      skipStateCookieCheck: false,
      accountLinking: { enabled: false, disableImplicitLinking: true, allowDifferentEmails: false },
    },
    databaseHooks: accountPrivacyHooks,
    session: { expiresIn: 7 * 24 * 60 * 60, cookieCache: { enabled: false } },
    // Libraries may include provider response bodies in errors; the app emits code-only errors.
    logger: { disabled: true },
    // better-call otherwise console.error()s non-APIError failures even with the logger disabled.
    // Its maintained router still converts APIError to the original status/headers response.
    onAPIError: { throw: true },
    plugins: [
      genericOAuth({ config: [{
        providerId: 'google',
        clientId: config.googleClientId,
        clientSecret: config.googleClientSecret,
        discoveryUrl: 'https://accounts.google.com/.well-known/openid-configuration',
        requireIdTokenVerification: true,
        accountSubject: verifiedGoogleSubject,
        // App sign-out ends the local session; no retained ID token or Google global logout is needed.
        disableProviderLogout: true,
        disableIdTokenNonceBinding: false,
        pkce: true,
        accessType: 'offline',
        prompt: 'select_account',
        redirectURI: config.googleCallback,
        scopes: [...GOOGLE_SCOPES],
        authorizationUrlParams: { include_granted_scopes: 'true' },
        tokenEndpointAuth: { method: 'client_secret_post' },
      }] }),
      jwt({ disableSettingJwtHeader: true, jwt: { issuer: config.issuer } }),
      mcp({
        loginPage: '/sign-in', consentPage: '/consent',
        resource: config.resource,
        resources: [{ identifier: config.resource, allowedScopes: [...OAUTH_SCOPES] }],
        scopes: [...OAUTH_SCOPES],
        grantTypes: ['authorization_code', 'refresh_token'],
        allowDynamicClientRegistration: false,
        allowUnauthenticatedClientRegistration: false,
        clientRegistrationRequirePKCE: true,
        storeTokens: 'hashed',
        // Recover duplicate refreshes/lost responses without minting another token pair.
        refreshTokenReuseInterval: 30,
        accessTokenExpiresIn: 300,
        refreshTokenExpiresIn: 7 * 24 * 60 * 60,
        codeExpiresIn: 120,
        postLogin: {
          page: '/connect',
          consentReferenceId: ({ user, session }) => hooks.consentReference(user.id, session.id),
          // Folder setup is a separate authenticated page and remains fail closed.
          shouldRedirect: ({ user }) => hooks.isBindingMissing(user.id),
        },
        extensions: [{ claims: { accessToken: async (input) => {
          if (!input.user || !input.referenceId || !input.resources?.includes(config.resource)) {
            throw new AuthBoundaryError('AUTH_REQUIRED');
          }
          return hooks.issueClaims({
            userId: input.user.id, clientId: input.client.clientId,
            referenceId: input.referenceId, scopes: input.scopes,
            grantType: input.grantType, sessionId: input.sessionId,
          });
        } } }],
      }),
      cimd({ fetchClientMetadataResource, metadataProfile: 'mcp-2026-07-28' }),
    ],
  } satisfies BetterAuthOptions;
}

/** Candidate: not mounted by api/index.ts until the acceptance gates pass in Termux. */
export function createAuth(config: AuthConfig, pool: Pool, authority: PostgresAuthAuthority) {
  return betterAuth(createAuthOptions(config,pool,{
    consentReference:(userId,sessionId)=>authority.consentReference(userId,sessionId),
    issueClaims:input=>authority.issueClaims(input),
    isBindingMissing:async userId=>{
      const tenant = await authority.ensureTenantForUser(userId);
      const binding = await pool.query('SELECT account_id FROM dw_mcp_bindings WHERE account_id=$1',[tenant.id]);
      return binding.rows.length !== 1;
    },
  }));
}

export type DriveWorkerAuth = ReturnType<typeof createAuth>;

/** No request headers: this is Better Auth's server-only account selection API. */
export function accessTokenForTenant(auth: DriveWorkerAuth, authority: PostgresAuthAuthority, tenantId: string) {
  return async (): Promise<string> => {
    const tenant = await authority.tenantForId(tenantId);
    try {
      const result = await auth.api.getAccessToken({ body: {
        accountId: tenant.better_auth_account_id,
        userId: tenant.better_auth_user_id,
      } });
      if (typeof result.accessToken !== 'string' || !result.accessToken) throw new AuthBoundaryError('GOOGLE_REAUTH_REQUIRED');
      return result.accessToken;
    } catch { throw new AuthBoundaryError('GOOGLE_REAUTH_REQUIRED'); }
  };
}
