import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { assertSchemaPresent } from '../src/auth/schema-readiness.ts';

test('catalog preflight requires the actual generated schema, app tables and enabled revocation triggers', async () => {
  const database = new PGlite();
  const adapter = { query: async (sql: string, values: unknown[]) => {
    const result = await database.query<Record<string, unknown>>(sql, values);
    return { rows: result.rows };
  } };
  try {
    await assert.rejects(assertSchemaPresent(adapter), { message: 'AUTH_DATABASE_NOT_READY' });
    for (const path of ['../sql/generated/better-auth-1.7.9.sql', '../sql/auth.sql', '../sql/core.sql']) {
      await database.exec(await readFile(new URL(path, import.meta.url), 'utf8'));
    }
    await assertSchemaPresent(adapter);
    await database.exec('ALTER TABLE "oauthRefreshToken" DISABLE TRIGGER dw_mcp_refresh_insert');
    await assert.rejects(assertSchemaPresent(adapter), { message: 'AUTH_DATABASE_NOT_READY' });
    await database.exec('ALTER TABLE "oauthRefreshToken" ENABLE TRIGGER dw_mcp_refresh_insert');
    await assertSchemaPresent(adapter);
    await database.exec('DROP TABLE dw_mcp_publications');
    await assert.rejects(assertSchemaPresent(adapter), { message: 'AUTH_DATABASE_NOT_READY' });
  } finally { await database.close(); }
});
