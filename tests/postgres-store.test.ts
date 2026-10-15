import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { PostgresStore } from '../src/postgres-store.ts';
import type { Publication } from '../src/contracts.ts';

test('Postgres schema and adapter preserve tenant keys, reservations, and confirmed states', async () => {
  const db = new PGlite();
  try {
    await db.exec('CREATE TABLE dw_mcp_tenants(id text primary key); INSERT INTO dw_mcp_tenants VALUES (\'a\'),(\'b\');');
    await db.exec(await readFile(new URL('../sql/core.sql', import.meta.url), 'utf8'));
    const store = new PostgresStore({ query: async (text, values) => db.query<Record<string, unknown>>(text, values) });
    const base: Publication = { accountId: 'a', jobId: 'MANUAL-J', route: 'manual', fileId: 'file-a', folderId: 'a-manual',
      contentHash: 'a'.repeat(64), routingPayloadHash: 'b'.repeat(64), routingEligible: true, state: 'PREPARING', createdTime: null };
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => store.reservePublication({ ...base, fileId: `file-${i}` })));
    assert.equal(new Set(results.map(r => r.fileId)).size, 1);
    const first = results[0]!;
    const changed = await store.reservePublication({ ...base, route: 'direct', contentHash: 'c'.repeat(64), fileId: 'discarded' });
    assert.equal(changed.route, 'manual'); assert.equal(changed.contentHash, base.contentHash); assert.equal(changed.fileId, first.fileId);
    const separate = await store.reservePublication({ ...base, accountId: 'b', fileId: 'file-b' });
    assert.equal(separate.accountId, 'b');
    await store.setPublicationState('a', base.jobId, 'PUBLISHED', '2026-01-01T00:00:00.000Z');
    const retained = await store.setPublicationState('a', base.jobId, 'UNKNOWN', '2027-01-01T00:00:00.000Z');
    assert.equal(retained.state, 'PUBLISHED'); assert.equal(retained.createdTime, '2026-01-01T00:00:00.000Z');
    assert.equal(await store.getPublication('other', base.jobId), null);
    await assert.rejects(db.query("INSERT INTO dw_mcp_bindings(account_id,manual_folder_id,commands_folder_id,results_folder_id) VALUES ('a','same','same','r')"));
  } finally { await db.close(); }
});
