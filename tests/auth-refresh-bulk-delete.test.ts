import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('bulk refresh deletion records one revocation per unexpired grant and preserves grant isolation', async () => {
  const db = new PGlite();
  const read = (path: string) => readFile(new URL(path, import.meta.url), 'utf8');
  try {
    await db.exec(await read('../sql/generated/better-auth-1.7.9.sql'));
    await db.exec(await read('../sql/auth.sql'));
    await db.exec(`
      INSERT INTO "user"(id,name,email,"emailVerified")
        SELECT u,u,u||'@example.invalid',true FROM unnest(ARRAY['u1','u2']) u;
      INSERT INTO "account"(id,"accountId","providerId","userId","updatedAt")
        SELECT id,id,'google',id,now() FROM "user";
      INSERT INTO dw_mcp_tenants(id,google_issuer,google_sub,better_auth_user_id,better_auth_account_id)
        SELECT id,'https://accounts.google.com',id,id,id FROM "user";
      INSERT INTO "oauthClient"(id,"clientId","redirectUris")
        SELECT c,c,'[]'::jsonb FROM unnest(ARRAY['c1','c2']) c;
      INSERT INTO dw_mcp_grants(id,tenant_id,client_id,reference_id) VALUES
        ('bulk','u1','c1','shared'),('other-client','u1','c2','shared'),
        ('other-user','u2','c1','shared'),('expired','u1','c1','expired'),
        ('prior','u1','c1','prior'),('live','u1','c1','live'),('isolated','u2','c2','shared');
      INSERT INTO "oauthRefreshToken"
        (id,token,"userId","clientId","referenceId","createdAt","expiresAt",scopes)
        SELECT g.id||n,g.id||n,g.tenant_id,g.client_id,g.reference_id,now(),
          now() + CASE WHEN g.id = 'expired' THEN interval '-1 day' ELSE interval '1 day' END,'[]'
        FROM dw_mcp_grants g CROSS JOIN LATERAL generate_series(1,CASE WHEN g.id='bulk' THEN 125 ELSE 1 END) n;
      UPDATE dw_mcp_grants SET revoked_at='2020-01-01' WHERE id='prior';
      CREATE TEMP TABLE grant_writes(id text);
      CREATE FUNCTION pg_temp.count_writes() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN INSERT INTO grant_writes VALUES (NEW.id); RETURN NEW; END; $$;
      CREATE TRIGGER count_writes AFTER INSERT OR UPDATE ON dw_mcp_grants
        FOR EACH ROW EXECUTE FUNCTION pg_temp.count_writes();
    `);
    // Replace the former row trigger while its grants and token rows exist.
    await db.exec(`CREATE OR REPLACE TRIGGER dw_mcp_refresh_delete AFTER DELETE ON "oauthRefreshToken"
      FOR EACH ROW EXECUTE FUNCTION dw_mcp_refresh_revoked();`);
    const upgrade = await read('../sql/migrations/20261125_refresh_delete.sql');
    await db.exec(upgrade);
    await db.exec(upgrade);
    assert.equal((await db.query('SELECT id FROM "oauthRefreshToken"')).rows.length, 131);
    assert.equal((await db.query('SELECT id FROM grant_writes')).rows.length, 0);

    const remove = `DELETE FROM "oauthRefreshToken" WHERE id NOT IN ('live1','isolated1')`;
    await db.exec('BEGIN');
    await db.exec(remove);
    await db.exec('ROLLBACK');
    assert.equal((await db.query('SELECT id FROM "oauthRefreshToken"')).rows.length, 131);
    assert.equal((await db.query('SELECT id FROM grant_writes')).rows.length, 0);
    await db.exec(remove);
    const ids = async (sql: string) => (await db.query<{id: string}>(sql)).rows.map(row => row.id);
    assert.deepEqual(await ids('SELECT id FROM grant_writes ORDER BY id'), ['bulk','other-client','other-user']);
    assert.deepEqual(await ids('SELECT id FROM dw_mcp_grants WHERE revoked_at IS NULL ORDER BY id'), ['expired','isolated','live']);
    assert.deepEqual(await ids("SELECT id FROM dw_mcp_grants WHERE revoked_at='2020-01-01'"), ['prior']);
    assert.deepEqual(await ids('SELECT id FROM "oauthRefreshToken" ORDER BY id'), ['isolated1','live1']);
    await assert.rejects(db.exec(`INSERT INTO "oauthRefreshToken"
      (id,token,"userId","clientId","referenceId","createdAt","expiresAt",scopes)
      VALUES ('new','synthetic','u1','c1','shared',now(),now()+interval '1 day','[]');`), /MCP_GRANT_REVOKED/);
  } finally { await db.close(); }
});
