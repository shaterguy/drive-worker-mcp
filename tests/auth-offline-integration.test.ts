import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { PostgresDialect } from 'kysely';
import { betterAuth } from 'better-auth';
import { importJWK, jwtVerify } from 'jose';
import type { Pool } from 'pg';
import { createAuthOptions } from '../src/auth/better-auth.ts';
import { PostgresAuthAuthority } from '../src/auth/authority.ts';
import { GOOGLE_SCOPES, loadAuthConfig } from '../src/auth/config.ts';

test('maintained rotation and signed app authority outlive session expiry/deletion while explicit revoke still tombstones the grant', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('UNEXPECTED_FIXTURE_NETWORK'); });
  const db = new PGlite();
  const query = async (sql: string, values: unknown[] = []) => {
    const result = await db.query<Record<string, unknown>>(sql, values);
    return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length, command: sql.trim().split(/\s/)[0]!.toUpperCase() };
  };
  const client = { query, release() {} };
  const pool = { query, connect: async () => client, end: async () => {} };
  const origin = 'https://offline-integration.invalid', resource = `${origin}/mcp`;
  const config = loadAuthConfig({ DWMCP_PUBLIC_ORIGIN: origin,
    DATABASE_URL: 'postgresql://fixture:fixture@db.invalid/db?sslmode=require',
    BETTER_AUTH_SECRET: 'synthetic-offline-integration-secret-never-use-in-production',
    GOOGLE_CLIENT_ID: 'synthetic-google-client', GOOGLE_CLIENT_SECRET: 'synthetic-google-secret' });
  const authority = new PostgresAuthAuthority(pool as unknown as Pool, resource, config.issuer);
  try {
    for (const path of ['../sql/generated/better-auth-1.7.9.sql', '../sql/auth.sql', '../sql/core.sql']) {
      await db.exec(await readFile(new URL(path, import.meta.url), 'utf8'));
    }
    const options = createAuthOptions(config, { dialect: new PostgresDialect({ pool: pool as never }), type: 'postgres' }, {
      consentReference: (userId, sessionId) => authority.consentReference(userId, sessionId),
      issueClaims: input => authority.issueClaims(input), isBindingMissing: async () => false,
    });
    const auth = betterAuth({ ...options, plugins: options.plugins.filter(plugin => plugin.id !== 'generic-oauth') });
    const context = await auth.$context, now = new Date();
    const user = await context.adapter.create<{ id: string }>({ model: 'user', data: {
      name: 'Synthetic fixture', email: 'offline@example.invalid', emailVerified: true, createdAt: now, updatedAt: now } });
    await context.adapter.create({ model: 'account', data: { userId: user.id, providerId: 'google',
      accountId: 'synthetic-google-subject', refreshToken: 'synthetic-stored-placeholder-not-used',
      scope: GOOGLE_SCOPES.join(','), createdAt: now, updatedAt: now } });
    const session = await context.adapter.create<{ id: string }>({ model: 'session', data: {
      userId: user.id, token: 'synthetic-browser-session', expiresAt: new Date(Date.now() + 86_400_000), createdAt: now, updatedAt: now } });
    const clientId = 'synthetic-offline-client', scopes = ['jobs:read', 'offline_access'];
    await context.adapter.create({ model: 'oauthClient', data: { clientId, disabled: false,
      tokenEndpointAuthMethod: 'none', requirePKCE: true, grantTypes: ['authorization_code', 'refresh_token'],
      responseTypes: ['code'], scopes, redirectUris: [`${origin}/callback`], createdAt: now, updatedAt: now } });
    await context.adapter.create({ model: 'oauthClientResource', data: { clientId, resourceId: resource, createdAt: now } });
    await context.adapter.create({ model: 'oauthConsent', data: { userId: user.id, clientId,
      referenceId: session.id, scopes, resources: [resource], createdAt: now, updatedAt: now } });
    await authority.issueClaims({ userId: user.id, clientId, referenceId: session.id, sessionId: session.id,
      grantType: 'authorization_code', scopes });
    const initialToken = 'synthetic-offline-refresh-token';
    await context.adapter.create({ model: 'oauthRefreshToken', data: {
      token: createHash('sha256').update(initialToken).digest('base64url'), clientId, userId: user.id,
      sessionId: session.id, referenceId: session.id, scopes, resources: [resource],
      expiresAt: new Date(Date.now() + 86_400_000), createdAt: now } });
    const refresh = (token: string) => auth.handler(new Request(`${config.issuer}/oauth2/token`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, refresh_token: token, resource }) }));
    const rotate = async (token: string) => {
      const response = await refresh(token);
      assert.equal(response.status, 200, await response.clone().text());
      return response.json() as Promise<{ access_token: string; refresh_token: string }>;
    };
    const principal = async (token: string) => {
      const response = await auth.handler(new Request(`${config.issuer}/jwks`));
      assert.equal(response.status, 200);
      const jwks = await response.json();
      const key = await importJWK(jwks.keys[0]);
      const verified = await jwtVerify(token, key, { issuer: config.issuer, audience: resource });
      return { claims: verified.payload, value: await authority.principalFromVerifiedClaims(verified.payload) };
    };

    await query('UPDATE "session" SET "expiresAt"=now()-interval \'1 day\' WHERE id=$1', [session.id]);
    const expiredSessionPair = await rotate(initialToken);
    const expiredSessionPrincipal = await principal(expiredSessionPair.access_token);
    assert.equal(expiredSessionPrincipal.claims.sid, session.id);
    const ttl = await query('SELECT EXTRACT(EPOCH FROM ("expiresAt"-"createdAt")) AS seconds FROM "oauthRefreshToken" WHERE revoked IS NULL');
    assert.equal(Number(ttl.rows[0]!.seconds), 90 * 24 * 60 * 60);

    await query('DELETE FROM "session" WHERE id=$1', [session.id]);
    const fk = await query('SELECT "sessionId" FROM "oauthRefreshToken" WHERE revoked IS NULL');
    assert.equal(fk.rows[0]!.sessionId, null);
    await authority.assertActiveGrant(expiredSessionPrincipal.value);
    const deletedSessionPair = await rotate(expiredSessionPair.refresh_token);
    const deletedSessionPrincipal = await principal(deletedSessionPair.access_token);
    assert.equal(deletedSessionPrincipal.claims.sid, null);
    await authority.assertActiveGrant(deletedSessionPrincipal.value);

    const revoked = await auth.handler(new Request(`${config.issuer}/oauth2/revoke`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, token: deletedSessionPair.refresh_token, token_type_hint: 'refresh_token' }) }));
    assert.equal(revoked.status, 200, await revoked.clone().text());
    const tombstone = await query('SELECT revoked_at IS NOT NULL AS revoked FROM dw_mcp_grants');
    assert.equal(tombstone.rows[0]!.revoked, true);
    await assert.rejects(authority.assertActiveGrant(deletedSessionPrincipal.value));
    assert.equal((await refresh(deletedSessionPair.refresh_token)).status, 400);
  } finally { await db.close(); }
});
