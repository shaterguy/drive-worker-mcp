import type { Pool } from 'pg';
import type { Drive } from '../contracts.ts';
import { AuthBoundaryError, GOOGLE_ISSUER, canonicalGoogleIdentity } from './config.ts';
import type { PostgresAuthAuthority } from './authority.ts';

export class Connections {
  readonly pool: Pool;
  readonly authority: PostgresAuthAuthority;
  readonly driveForAccount: (accountId: string) => Promise<Drive>;
  constructor(pool: Pool, authority: PostgresAuthAuthority, driveForAccount: (accountId: string) => Promise<Drive>) {
    this.pool=pool; this.authority=authority; this.driveForAccount=driveForAccount;
  }

  async requireGoogleGrant(tenantId: string): Promise<void> {
    await this.authority.requireGoogleGrant(tenantId);
  }

  async bindInitial(userId: string, value: unknown): Promise<void> {
    if (!value || typeof value !== 'object') throw new AuthBoundaryError('INVALID_BINDING');
    const input = value as Record<string, unknown>;
    const fields = ['manualFolderId','commandsFolderId','resultsFolderId','stateFolderId'] as const;
    const ids = fields.map(field => {
      const id = input[field];
      if (field === 'stateFolderId' && (id === '' || id === undefined)) return undefined;
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(id)) throw new AuthBoundaryError('INVALID_BINDING');
      return id;
    });
    const selected = ids.filter((id): id is string => id !== undefined);
    if (new Set(selected).size !== selected.length) throw new AuthBoundaryError('INVALID_BINDING');
    const tenant = await this.authority.ensureTenantForUser(userId);
    await this.requireGoogleGrant(tenant.id);
    const drive = await this.driveForAccount(tenant.id);
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i]; if (!id) continue;
      const folder = await drive.getMetadata(id);
      if (!folder || folder.trashed || folder.mimeType !== 'application/vnd.google-apps.folder' ||
        (i < 2 && folder.capabilities?.canAddChildren !== true)) throw new AuthBoundaryError('FOLDER_ACCESS_REQUIRED');
    }
    await this.pool.query(`INSERT INTO dw_mcp_bindings
      (account_id,manual_folder_id,commands_folder_id,results_folder_id,state_folder_id)
      VALUES ($1,$2,$3,$4,$5) ON CONFLICT (account_id) DO NOTHING`, [tenant.id,...ids.map(id => id ?? null)]);
    const binding = await this.pool.query(`SELECT 1 FROM dw_mcp_bindings WHERE account_id=$1
      AND manual_folder_id=$2 AND commands_folder_id=$3 AND results_folder_id=$4 AND state_folder_id IS NOT DISTINCT FROM $5`,
    [tenant.id,...ids.map(id => id ?? null)]);
    if (binding.rows.length !== 1) throw new AuthBoundaryError('BINDING_ALREADY_EXISTS');
  }

  async list(userId: string) {
    const tenant = await this.authority.ensureTenantForUser(userId);
    const [binding, grants] = await Promise.all([
      this.pool.query(`SELECT manual_folder_id,commands_folder_id,results_folder_id,state_folder_id FROM dw_mcp_bindings WHERE account_id=$1`, [tenant.id]),
      this.pool.query<{ id: string; client_id: string; revoked_at: Date | null }>(
        'SELECT id,client_id,revoked_at FROM dw_mcp_grants WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100', [tenant.id]),
    ]);
    // ensureTenantForUser resolved the session user through the verified Google account, never email/input.
    return { identity:canonicalGoogleIdentity(GOOGLE_ISSUER,tenant.google_sub), binding: binding.rows[0] ?? null, grants: grants.rows };
  }

  async disconnect(userId: string, grantId: unknown): Promise<void> {
    if (typeof grantId !== 'string' || !/^[0-9a-f-]{36}$/i.test(grantId)) throw new AuthBoundaryError('INVALID_REQUEST');
    const tenant = await this.authority.ensureTenantForUser(userId);
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const rows = await db.query<{ client_id: string; reference_id: string }>(
        'SELECT client_id,reference_id FROM dw_mcp_grants WHERE id=$1 AND tenant_id=$2 FOR UPDATE', [grantId,tenant.id]);
      const grant = rows.rows[0]; if (!grant) throw new AuthBoundaryError('AUTH_REQUIRED');
      await db.query('UPDATE dw_mcp_grants SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND tenant_id=$2', [grantId,tenant.id]);
      await db.query('DELETE FROM "oauthConsent" WHERE "userId"=$1 AND "clientId"=$2 AND "referenceId"=$3', [userId,grant.client_id,grant.reference_id]);
      await db.query(`DELETE FROM "oauthAccessToken" WHERE "refreshId" IN
        (SELECT id FROM "oauthRefreshToken" WHERE "userId"=$1 AND "clientId"=$2 AND "referenceId"=$3)`, [userId,grant.client_id,grant.reference_id]);
      await db.query('DELETE FROM "oauthRefreshToken" WHERE "userId"=$1 AND "clientId"=$2 AND "referenceId"=$3', [userId,grant.client_id,grant.reference_id]);
      await db.query('COMMIT');
    } catch (error) { await db.query('ROLLBACK'); throw error; } finally { db.release(); }
    // Tenant, folder bindings, Google grant and Drive files are deliberately preserved.
  }
}
