-- Apply only to the new dedicated database, AFTER Better Auth 1.7.8's generated migration.
-- No Google/MCP token values are stored in these application tables.
BEGIN;
CREATE TABLE IF NOT EXISTS dw_mcp_tenants (
  id TEXT PRIMARY KEY,
  google_issuer TEXT NOT NULL CHECK (google_issuer='https://accounts.google.com'),
  google_sub TEXT NOT NULL,
  better_auth_user_id TEXT NOT NULL UNIQUE REFERENCES "user"(id),
  better_auth_account_id TEXT NOT NULL UNIQUE REFERENCES "account"(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (google_issuer,google_sub)
);
CREATE TABLE IF NOT EXISTS dw_mcp_grants (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES dw_mcp_tenants(id),
  client_id TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ,
  UNIQUE (tenant_id,client_id,reference_id)
);

-- Committed tombstones block subsequent requests/tools after explicit revoke or family deletion.
-- They do NOT fix the provider's documented CAS-loser gap: a losing concurrent refresh
-- does not itself synchronously invalidate the winning family. Client policy/replay tests remain gates.
-- They are immutable and survive consent re-creation: reconnect uses a NEW sign-in session.
CREATE OR REPLACE FUNCTION dw_mcp_tombstone_grant(u TEXT,c TEXT,r TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF r IS NULL THEN RETURN; END IF;
  INSERT INTO dw_mcp_grants(id,tenant_id,client_id,reference_id,revoked_at)
    SELECT gen_random_uuid()::text,id,c,r,now() FROM dw_mcp_tenants WHERE better_auth_user_id=u
    ON CONFLICT(tenant_id,client_id,reference_id) DO UPDATE SET revoked_at=COALESCE(dw_mcp_grants.revoked_at,now());
END; $$;

CREATE OR REPLACE FUNCTION dw_mcp_consent_revoked() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM dw_mcp_tombstone_grant(OLD."userId",OLD."clientId",OLD."referenceId");
  RETURN OLD;
END; $$;
CREATE TRIGGER dw_mcp_consent_delete AFTER DELETE ON "oauthConsent"
  FOR EACH ROW EXECUTE FUNCTION dw_mcp_consent_revoked();

-- Better Auth adapters may materialize string[] as native arrays or JSON text.
-- The actual generated schema must be inspected and these fixtures run before applying.
CREATE OR REPLACE FUNCTION dw_mcp_json_string_set(v JSONB) RETURNS JSONB
LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF v IS NULL OR v='null'::jsonb THEN RETURN '[]'::jsonb; END IF;
  IF jsonb_typeof(v)='string' THEN v := (v #>> '{}')::jsonb; END IF;
  IF jsonb_typeof(v)<>'array' OR EXISTS
    (SELECT 1 FROM jsonb_array_elements(v) e WHERE jsonb_typeof(e)<>'string') THEN
    RAISE EXCEPTION 'MCP_AUTH_SCHEMA_INVALID';
  END IF;
  RETURN v;
END; $$;
CREATE OR REPLACE FUNCTION dw_mcp_consent_reduced() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."userId" IS DISTINCT FROM OLD."userId" OR NEW."clientId" IS DISTINCT FROM OLD."clientId"
    OR NEW."referenceId" IS DISTINCT FROM OLD."referenceId"
    OR NOT (dw_mcp_json_string_set(to_jsonb(NEW.scopes)) @> dw_mcp_json_string_set(to_jsonb(OLD.scopes)))
    OR NOT (dw_mcp_json_string_set(to_jsonb(NEW.resources)) @> dw_mcp_json_string_set(to_jsonb(OLD.resources))) THEN
    PERFORM dw_mcp_tombstone_grant(OLD."userId",OLD."clientId",OLD."referenceId");
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER dw_mcp_consent_update AFTER UPDATE ON "oauthConsent"
  FOR EACH ROW EXECUTE FUNCTION dw_mcp_consent_reduced();

CREATE OR REPLACE FUNCTION dw_mcp_grant_immutable() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'MCP_GRANT_TOMBSTONE_REQUIRED'; END IF;
  IF NEW.id<>OLD.id OR NEW.tenant_id<>OLD.tenant_id OR NEW.client_id<>OLD.client_id
    OR NEW.reference_id<>OLD.reference_id OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'MCP_GRANT_IMMUTABLE';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER dw_mcp_grant_immutable_update BEFORE UPDATE OR DELETE ON dw_mcp_grants
  FOR EACH ROW EXECUTE FUNCTION dw_mcp_grant_immutable();

CREATE OR REPLACE FUNCTION dw_mcp_refresh_revoked() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    -- Expired-row retention cleanup must not invalidate a newer active rotation.
    IF OLD."expiresAt">now() THEN
      PERFORM dw_mcp_tombstone_grant(OLD."userId",OLD."clientId",OLD."referenceId");
    END IF;
    RETURN OLD;
  END IF;
  -- Normal rotation atomically sets both revoked and rotatedAt; explicit revoke sets revoked only.
  IF NEW.revoked IS NOT NULL AND OLD.revoked IS NULL AND NEW."rotatedAt" IS NULL THEN
    PERFORM dw_mcp_tombstone_grant(NEW."userId",NEW."clientId",NEW."referenceId");
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER dw_mcp_refresh_revoke AFTER UPDATE OF revoked ON "oauthRefreshToken"
  FOR EACH ROW EXECUTE FUNCTION dw_mcp_refresh_revoked();
CREATE TRIGGER dw_mcp_refresh_delete AFTER DELETE ON "oauthRefreshToken"
  FOR EACH ROW EXECUTE FUNCTION dw_mcp_refresh_revoked();

CREATE OR REPLACE FUNCTION dw_mcp_reject_revoked_refresh() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE grant_row dw_mcp_grants%ROWTYPE;
BEGIN
  SELECT g.* INTO grant_row FROM dw_mcp_grants g JOIN dw_mcp_tenants t ON t.id=g.tenant_id
    WHERE t.better_auth_user_id=NEW."userId" AND g.client_id=NEW."clientId"
      AND g.reference_id=NEW."referenceId" FOR SHARE OF g;
  -- Claims extension creates the active row BEFORE Better Auth inserts the refresh row.
  -- Row locking serializes this check with concurrent tombstoning.
  IF NOT FOUND OR grant_row.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'MCP_GRANT_REVOKED';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER dw_mcp_refresh_insert BEFORE INSERT ON "oauthRefreshToken"
  FOR EACH ROW EXECUTE FUNCTION dw_mcp_reject_revoked_refresh();
COMMIT;
