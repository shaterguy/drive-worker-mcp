import test from 'node:test';
import assert from 'node:assert/strict';
import { betterAuth } from 'better-auth';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { createSchemaOptions } from '../scripts/schema-config.ts';
import { createDeployment } from '../src/auth/deployment.ts';

const origin = 'https://schema-only.invalid';
const env = { DWMCP_PUBLIC_ORIGIN: origin, DATABASE_URL: 'postgresql://fixture:fixture@db.example.invalid/db?sslmode=require',
  BETTER_AUTH_SECRET: 'synthetic-fixture-server-secret-not-for-production',
  GOOGLE_CLIENT_ID: 'fixture-client', GOOGLE_CLIENT_SECRET: 'fixture-private' };
const sentinel = 'SYNTHETIC_DB_PASSWORD_SENTINEL_NOT_A_REAL_SECRET';

function fixture() {
  const options = createSchemaOptions(memoryAdapter({}));
  // Exact factory error policy; only local synthetic endpoints, no Google/DB/network initializer.
  const auth = betterAuth({ ...options, plugins: [{ id: 'error-boundary-fixture', endpoints: {
    fixtureFailure: createAuthEndpoint('/fixture-failure', { method: 'GET' }, async () => {
      throw new Error(`synthetic DB failure ${sentinel}`, { cause: { databaseUrl: `postgresql://fixture:${sentinel}@db.invalid/db` } });
    }),
    fixtureUnauthorized: createAuthEndpoint('/fixture-unauthorized', { method: 'GET' }, async () => {
      throw new APIError('UNAUTHORIZED', { error: 'invalid_token' }, { 'WWW-Authenticate': 'Bearer error="invalid_token"' });
    }),
    fixtureForbidden: createAuthEndpoint('/fixture-forbidden', { method: 'GET' }, async () => {
      throw new APIError('FORBIDDEN', { error: 'insufficient_scope' }, { 'WWW-Authenticate': 'Bearer error="insufficient_scope", scope="jobs:read"' });
    }),
    fixtureRedirect: createAuthEndpoint('/fixture-redirect', { method: 'GET' }, async () => {
      const headers = new Headers({ Location: `${origin}/connect` });
      headers.append('set-cookie', 'a=synthetic; HttpOnly'); headers.append('set-cookie', 'b=synthetic; HttpOnly');
      throw new APIError('FOUND', undefined, headers);
    }),
  } }] });
  return createDeployment({ environment: () => env, load: async () => ({
    checkDatabase: async () => {}, fetch: request => auth.handler(request),
  }) });
}

test('maintained handler never logs an unexpected error or its cause before sanitized failure', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('UNEXPECTED_FIXTURE_NETWORK'); });
  let consoleErrors = 0;
  // A test-only spy; production does not replace or intercept global console methods.
  t.mock.method(console, 'error', (..._args: unknown[]) => { consoleErrors++; });
  const response = await fixture().fetch(new Request(`${origin}/api/auth/fixture-failure`));
  assert.equal(response.status, 503);
  const body = await response.text();
  assert.equal(body, JSON.stringify({ error: 'AUTH_NOT_READY' }));
  assert.equal(body.includes(sentinel), false);
  assert.equal(consoleErrors, 0, 'UNEXPECTED_LIBRARY_FALLBACK_LOG');
});

test('maintained APIError keeps 401/403 challenges and redirect cookies with throw policy enabled', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('UNEXPECTED_FIXTURE_NETWORK'); });
  let consoleErrors = 0;
  t.mock.method(console, 'error', (..._args: unknown[]) => { consoleErrors++; });
  const deployment = fixture();
  for (const [path, status, challenge] of [
    ['/fixture-unauthorized', 401, 'Bearer error="invalid_token"'],
    ['/fixture-forbidden', 403, 'Bearer error="insufficient_scope", scope="jobs:read"'],
  ] as const) {
    const response = await deployment.fetch(new Request(`${origin}/api/auth${path}`));
    assert.equal(response.status, status);
    assert.equal(response.headers.get('www-authenticate'), challenge);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  const redirect = await deployment.fetch(new Request(`${origin}/api/auth/fixture-redirect`));
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get('location'), `${origin}/connect`);
  assert.deepEqual(redirect.headers.getSetCookie(), ['a=synthetic; HttpOnly', 'b=synthetic; HttpOnly']);
  assert.equal(consoleErrors, 0);
});
