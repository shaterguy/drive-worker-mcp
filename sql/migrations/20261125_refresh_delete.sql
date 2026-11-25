-- Existing installations. No provider rows or grant records are rewritten.
BEGIN;
CREATE OR REPLACE FUNCTION dw_mcp_tombstone_grant(u TEXT,c TEXT,r TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF r IS NULL THEN RETURN; END IF;
  INSERT INTO dw_mcp_grants(id,tenant_id,client_id,reference_id,revoked_at)
    SELECT gen_random_uuid()::text,id,c,r,now() FROM dw_mcp_tenants WHERE better_auth_user_id=u
    ON CONFLICT(tenant_id,client_id,reference_id) DO UPDATE SET revoked_at=EXCLUDED.revoked_at
    WHERE dw_mcp_grants.revoked_at IS NULL;
END; $$;

-- A family-wide delete can remove many unexpired rotations of the same grant.
CREATE OR REPLACE FUNCTION dw_mcp_refresh_rows_deleted()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE family RECORD;
BEGIN
  FOR family IN
    SELECT DISTINCT "userId", "clientId", "referenceId" FROM deleted_refresh_rows
    WHERE "expiresAt" > now() AND "referenceId" IS NOT NULL
    ORDER BY "userId", "clientId", "referenceId"
  LOOP
    PERFORM dw_mcp_tombstone_grant(family."userId", family."clientId", family."referenceId");
  END LOOP;
  RETURN NULL;
END; $$;
CREATE OR REPLACE TRIGGER dw_mcp_refresh_delete AFTER DELETE ON "oauthRefreshToken"
  REFERENCING OLD TABLE AS deleted_refresh_rows
  FOR EACH STATEMENT EXECUTE FUNCTION dw_mcp_refresh_rows_deleted();
COMMIT;
