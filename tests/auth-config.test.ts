import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalGoogleIdentity, loadAuthConfig, parsePublicOrigin } from '../src/auth/config.ts';
import { healthResponse, authNotReadyResponse } from '../src/auth/health.ts';

test('host is operator configured with no request-derived fallback', () => {
  assert.throws(() => parsePublicOrigin(undefined));
  for (const bad of ['http://example.com', 'https://user:password@example.com', 'https://example.com/path',
    'https://example.com/?token=x', 'https://example.com/#x', 'https://localhost', 'https://127.0.0.1',
    'https://*.example.com', 'https://example.com:8443']) assert.throws(() => parsePublicOrigin(bad));
  assert.equal(parsePublicOrigin('https://verified.example.test/'), 'https://verified.example.test');
});

test('configuration fails closed and does not print secret values in error messages', () => {
  const env = { DWMCP_PUBLIC_ORIGIN: 'https://verified.example.test', DATABASE_URL: 'postgresql://test:test@db.example.test/db?sslmode=require',
    BETTER_AUTH_SECRET: 'fixture-only-secret-never-use-in-production', GOOGLE_CLIENT_ID: 'fixture-client', GOOGLE_CLIENT_SECRET: 'fixture-private' };
  const config = loadAuthConfig(env);
  assert.equal(config.googleCallback, 'https://verified.example.test/api/auth/callback/google');
  assert.equal(config.issuer, 'https://verified.example.test/api/auth');
  assert.equal(config.resource, 'https://verified.example.test/mcp');
  assert.throws(() => loadAuthConfig({ ...env, DATABASE_URL: 'postgresql://test:test@db.example.test/db' }));
  assert.throws(() => loadAuthConfig({ ...env, GOOGLE_CLIENT_SECRET: undefined }), { message: 'AUTH_CONFIGURATION_REQUIRED' });
});

test('identity uses issuer and subject, never email', () => {
  assert.deepEqual(canonicalGoogleIdentity('accounts.google.com', '123456'), { issuer: 'https://accounts.google.com', sub: '123456' });
  assert.throws(() => canonicalGoogleIdentity('https://attacker.test', '123456'));
  assert.throws(() => canonicalGoogleIdentity('https://accounts.google.com', ''));
});

test('legacy static response helpers never claim OAuth acceptance; mounted health is tested separately', async () => {
  const health = await healthResponse().json();
  assert.equal(health.user_ready, false);
  assert.equal(health.authentication, 'not_ready');
  assert.equal(authNotReadyResponse().status, 503);
});
