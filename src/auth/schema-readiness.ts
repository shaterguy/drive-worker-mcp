import { AuthBoundaryError } from './config.ts';

/** Read-only catalog preflight, not a migration runner or a substitute for SQL/hash review. */
export const REQUIRED_TABLES = Object.freeze([
  'user', 'session', 'account', 'verification', 'jwks', 'oauthAccessToken',
  'oauthClient', 'oauthClientAssertion', 'oauthClientResource', 'oauthConsent',
  'oauthRefreshToken', 'oauthResource', 'dw_mcp_tenants', 'dw_mcp_grants',
  'dw_mcp_bindings', 'dw_mcp_publications',
]);
export const REQUIRED_TRIGGERS = Object.freeze([
  ['dw_mcp_grants', 'dw_mcp_grant_immutable_update'],
  ['oauthConsent', 'dw_mcp_consent_delete'],
  ['oauthConsent', 'dw_mcp_consent_update'],
  ['oauthRefreshToken', 'dw_mcp_refresh_delete'],
  ['oauthRefreshToken', 'dw_mcp_refresh_insert'],
  ['oauthRefreshToken', 'dw_mcp_refresh_revoke'],
]);

export interface ReadinessDatabase {
  query(text: string, values: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export async function assertSchemaPresent(database: ReadinessDatabase): Promise<void> {
  const result = await database.query(`
    SELECT current_schema()='public' AS schema_ok,
      NOT EXISTS (
        SELECT 1 FROM unnest($1::text[]) expected(name)
        WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
          JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relname=expected.name AND c.relkind='r')
      ) AS tables_ok,
      NOT EXISTS (
        SELECT 1 FROM jsonb_to_recordset($2::jsonb) expected(table_name text, trigger_name text)
        WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t
          JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid
          JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
          WHERE n.nspname='public' AND c.relname=expected.table_name
            AND t.tgname=expected.trigger_name AND NOT t.tgisinternal
            AND t.tgenabled IN ('O','A'))
      ) AS triggers_ok`,
  [REQUIRED_TABLES, JSON.stringify(REQUIRED_TRIGGERS.map(([table_name, trigger_name]) => ({ table_name, trigger_name })))]);
  const row = result.rows[0];
  if (result.rows.length !== 1 || row?.schema_ok !== true || row.tables_ok !== true || row.triggers_ok !== true) {
    throw new AuthBoundaryError('AUTH_DATABASE_NOT_READY');
  }
}
