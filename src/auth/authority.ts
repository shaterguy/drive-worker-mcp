import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { Principal, ToolScope } from '../contracts.ts';
import { AuthBoundaryError, GOOGLE_ISSUER, TOOL_SCOPES, canonicalGoogleIdentity } from './config.ts';
import { hasRequiredDriveScopes } from './google-readiness.ts';
import { observePrincipalRead, type RequestDiagnostics } from './request-diagnostics.ts';

export const TENANT_CLAIM = 'urn:drive-worker-mcp:tenant';
export const GRANT_CLAIM = 'urn:drive-worker-mcp:grant';
export const REFERENCE_CLAIM = 'urn:drive-worker-mcp:reference';
type Queryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;
export interface Tenant { id: string; better_auth_user_id: string; better_auth_account_id: string; google_sub: string }
interface Grant { id: string; tenant_id: string; client_id: string; reference_id: string; revoked_at: Date | null }
interface ClaimInput {
  userId: string; clientId: string; referenceId: string; scopes: readonly string[];
  grantType: string | undefined; sessionId: string | undefined;
}
interface Proof { userId: string; referenceId: string; sessionId?: string; expiresAt: number; scopes: readonly ToolScope[] }

function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 2048) throw new AuthBoundaryError('AUTH_REQUIRED');
  return value;
}
export function readStoredList(value: unknown): string[] {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { throw new AuthBoundaryError('AUTH_STATE_INVALID'); }
  }
  if (!Array.isArray(value) || value.length > 100 || !value.every(x => typeof x === 'string')) {
    throw new AuthBoundaryError('AUTH_STATE_INVALID');
  }
  return value;
}

/** Stores only identity and grant state. Google credential encryption/refresh belongs to Better Auth. */
export class PostgresAuthAuthority {
  readonly #pool: Pool;
  readonly #resource: string;
  readonly #userInfoAudience: string;
  readonly #proofs = new WeakMap<Principal, Proof>();
  constructor(pool: Pool, resource: string, issuer: string) {
    this.#pool = pool; this.#resource = resource; this.#userInfoAudience = `${issuer}/oauth2/userinfo`;
  }

  async ensureTenantForUser(userId: string): Promise<Tenant> {
    const accounts = await this.#pool.query<{ id: string; accountId: string }>(
      'SELECT id, "accountId" FROM "account" WHERE "userId"=$1 AND "providerId"=$2 LIMIT 2', [userId, 'google']);
    if (accounts.rows.length !== 1) throw new AuthBoundaryError('GOOGLE_IDENTITY_INVALID');
    const account = accounts.rows[0]!;
    const identity = canonicalGoogleIdentity(GOOGLE_ISSUER, account.accountId);
    // Only this service's verified OIDC provider may create Google accounts. No email linking.
    const result = await this.#pool.query<Tenant>(
      `INSERT INTO dw_mcp_tenants (id, google_issuer, google_sub, better_auth_user_id, better_auth_account_id)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT (google_issuer,google_sub)
       DO UPDATE SET last_seen_at=now()
       WHERE dw_mcp_tenants.better_auth_user_id=EXCLUDED.better_auth_user_id
         AND dw_mcp_tenants.better_auth_account_id=EXCLUDED.better_auth_account_id
       RETURNING *`, [randomUUID(), identity.issuer, identity.sub, userId, account.id]);
    if (result.rows.length !== 1) throw new AuthBoundaryError('GOOGLE_IDENTITY_CONFLICT');
    return result.rows[0]!;
  }

  async tenantForId(id: string): Promise<Tenant> {
    const result = await this.#pool.query<Tenant>(
      `SELECT t.* FROM dw_mcp_tenants t JOIN "account" a ON a.id=t.better_auth_account_id
       AND a."userId"=t.better_auth_user_id AND a."providerId"='google' AND a."accountId"=t.google_sub
       WHERE t.id=$1 AND t.google_issuer=$2`, [id, GOOGLE_ISSUER]);
    if (result.rows.length !== 1) throw new AuthBoundaryError('GOOGLE_REAUTH_REQUIRED');
    return result.rows[0]!;
  }

  /** Reads readiness metadata only. Stored Google credential values never leave Better Auth. */
  async requireGoogleGrant(tenantId: string): Promise<void> {
    await this.#requireGoogleGrant(this.#pool, await this.tenantForId(tenantId));
  }

  async #requireGoogleGrant(db: Queryable, tenant: Tenant): Promise<void> {
    const result = await db.query<{ has_refresh: boolean; scope: string | null }>(
      `SELECT ("refreshToken" IS NOT NULL AND "refreshToken"<>'') AS has_refresh, scope
       FROM "account" WHERE id=$1 AND "userId"=$2 AND "providerId"='google' AND "accountId"=$3`,
      [tenant.better_auth_account_id,tenant.better_auth_user_id,tenant.google_sub]);
    const row = result.rows[0];
    const scopes = (row?.scope ?? '').split(/[ ,]+/);
    // Google canonicalizes identity scope aliases; only the two Drive scopes belong in this check.
    const ready = result.rows.length === 1 && row?.has_refresh === true &&
      hasRequiredDriveScopes(scopes);
    if (!ready) throw new AuthBoundaryError('GOOGLE_REAUTH_REQUIRED');
  }

  async consentReference(userId: string, sessionId: string): Promise<string> {
    await this.ensureTenantForUser(userId);
    await this.#requireSession(this.#pool, userId, sessionId);
    return sessionId; // Stable across all continuations of this authorization flow.
  }

  async #requireSession(db: Queryable, userId: string, sessionId: string): Promise<void> {
    const result = await db.query('SELECT id FROM "session" WHERE id=$1 AND "userId"=$2 AND "expiresAt">now()', [sessionId,userId]);
    if (result.rows.length !== 1) throw new AuthBoundaryError('AUTH_REQUIRED');
  }

  async #requireConsent(db: Queryable, userId: string, clientId: string, referenceId: string, scopes: readonly string[]): Promise<boolean> {
    const result = await db.query<{ scopes: unknown; resources: unknown }>(
      `SELECT c.scopes,c.resources FROM "oauthConsent" c JOIN "oauthClient" p ON p."clientId"=c."clientId"
       WHERE c."userId"=$1 AND c."clientId"=$2 AND c."referenceId"=$3 AND p.disabled IS NOT TRUE LIMIT 2`,
      [userId,clientId,referenceId]);
    if (result.rows.length !== 1) throw new AuthBoundaryError('AUTH_REQUIRED');
    const row = result.rows[0]!;
    if (!readStoredList(row.resources).includes(this.#resource) ||
        !scopes.every(scope => readStoredList(row.scopes).includes(scope))) throw new AuthBoundaryError('INSUFFICIENT_SCOPE');
    return readStoredList(row.scopes).includes('offline_access');
  }

  async issueClaims(input: ClaimInput): Promise<Record<string, string>> {
    if (!['authorization_code','refresh_token'].includes(input.grantType ?? '')) throw new AuthBoundaryError('AUTH_REQUIRED');
    const tenant = await this.ensureTenantForUser(input.userId);
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      // Existing folder bindings bypass setup, so token issuance must independently enforce readiness.
      await this.#requireGoogleGrant(client,tenant);
      const offline = await this.#requireConsent(client, input.userId, input.clientId, input.referenceId, input.scopes);
      // Durable offline consent outlives the browser session. Initial code exchange
      // and online-only grants still require it; referenceId remains the grant lineage.
      if (input.grantType === 'authorization_code' || !offline) {
        await this.#requireSession(client, input.userId, input.referenceId);
      }
      if (input.sessionId && input.sessionId !== input.referenceId) throw new AuthBoundaryError('AUTH_REQUIRED');
      if (input.grantType === 'authorization_code') {
        if (!input.sessionId || input.referenceId !== input.sessionId) throw new AuthBoundaryError('AUTH_REQUIRED');
        await client.query(`INSERT INTO dw_mcp_grants (id,tenant_id,client_id,reference_id)
          VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id,client_id,reference_id) DO NOTHING`,
        [randomUUID(),tenant.id,input.clientId,input.referenceId]);
      }
      const grants = await client.query<Grant>(
        `SELECT * FROM dw_mcp_grants WHERE tenant_id=$1 AND client_id=$2 AND reference_id=$3 FOR SHARE`,
        [tenant.id,input.clientId,input.referenceId]);
      const grant = grants.rows[0];
      if (!grant || grant.revoked_at) throw new AuthBoundaryError('AUTH_REQUIRED');
      await client.query('COMMIT');
      return { [TENANT_CLAIM]: tenant.id, [GRANT_CLAIM]: grant.id, [REFERENCE_CLAIM]: grant.reference_id };
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  /** Claims MUST already have passed requireMcpAuth's signature/issuer/resource/expiry/DPoP checks. */
  async principalFromVerifiedClaims(claims: Record<string, unknown>, diagnostic?: RequestDiagnostics): Promise<Principal> {
    const accountId = text(claims[TENANT_CLAIM]);
    const grantId = text(claims[GRANT_CLAIM]);
    const referenceId = text(claims[REFERENCE_CLAIM]);
    const clientId = text(claims.client_id);
    const audiences = typeof claims.aud === 'string' ? [claims.aud] : claims.aud;
    if (!Array.isArray(audiences) || !audiences.includes(this.#resource) ||
        !audiences.every(aud => aud === this.#resource || aud === this.#userInfoAudience) ||
        claims.azp !== clientId || typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) ||
        claims.exp * 1000 <= Date.now()) throw new AuthBoundaryError('AUTH_REQUIRED');
    const signedScopes = text(claims.scope).split(' ');
    const scopes = new Set<ToolScope>(TOOL_SCOPES.filter(scope => signedScopes.includes(scope)));
    const principal: Principal = Object.freeze({ accountId, grantId, clientId, scopes });
    const proof: Proof = { userId: text(claims.sub), referenceId, expiresAt: claims.exp * 1000, scopes: [...scopes] };
    if (claims.sid !== undefined && claims.sid !== null) {
      proof.sessionId = text(claims.sid);
      if (proof.sessionId !== referenceId) throw new AuthBoundaryError('AUTH_REQUIRED');
    }
    this.#proofs.set(principal, proof);
    await this.assertActiveGrant(principal,diagnostic);
    return principal;
  }

  /** Called at the route boundary AND immediately before every individual tool. No cache. */
  async assertActiveGrant(principal: Principal, diagnostic?: RequestDiagnostics): Promise<void> {
    const proof = this.#proofs.get(principal);
    if (!proof || proof.expiresAt <= Date.now()) throw new AuthBoundaryError('AUTH_REQUIRED');
    if (principal.scopes.size !== proof.scopes.length || !proof.scopes.every(scope => principal.scopes.has(scope))) {
      throw new AuthBoundaryError('AUTH_REQUIRED');
    }
    const tenant = await observePrincipalRead(diagnostic,'tenant',async()=>{
      const value=await this.tenantForId(principal.accountId);
      if (value.better_auth_user_id !== proof.userId) throw new AuthBoundaryError('AUTH_REQUIRED');
      return value;
    });
    await observePrincipalRead(diagnostic,'google_ready',()=>this.#requireGoogleGrant(this.#pool,tenant));
    await observePrincipalRead(diagnostic,'grant',async()=>{
      const grants = await this.#pool.query<Grant>(
        `SELECT * FROM dw_mcp_grants WHERE id=$1 AND tenant_id=$2 AND client_id=$3 AND reference_id=$4 AND revoked_at IS NULL`,
        [principal.grantId,principal.accountId,principal.clientId,proof.referenceId]);
      if (grants.rows.length !== 1) throw new AuthBoundaryError('AUTH_REQUIRED');
    });
    const offline = await observePrincipalRead(diagnostic,'consent',()=>this.#requireConsent(this.#pool,proof.userId,principal.clientId,proof.referenceId,proof.scopes));
    if (!offline) await observePrincipalRead(diagnostic,'session',()=>this.#requireSession(this.#pool,proof.userId,proof.referenceId));
  }
}
