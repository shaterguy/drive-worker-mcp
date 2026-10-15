import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createDeployment, type MountedRuntime } from '../src/auth/deployment.ts';
import { AuthBoundaryError } from '../src/auth/config.ts';

const origin = 'https://verified.example.test';
const env = { DWMCP_PUBLIC_ORIGIN: origin, DATABASE_URL: 'postgresql://fixture:fixture@db.example.test/db?sslmode=require',
  BETTER_AUTH_SECRET: 'synthetic-fixture-secret-never-use-in-production', GOOGLE_CLIENT_ID: 'fixture-client',
  GOOGLE_CLIENT_SECRET: 'fixture-private' };
const request = (path: string) => new Request(`${origin}${path}`);
const ready = (): MountedRuntime => ({ checkDatabase: async () => {}, fetch: async () => new Response('fixture') });

test('mount stays 503 without complete configuration and never initializes a database', async () => {
  let loads = 0;
  const deployment = createDeployment({ environment: () => ({}), load: async () => { loads++; return ready(); } });
  const health = await deployment.fetch(request('/health'));
  assert.equal(health.status, 503);
  assert.deepEqual(await health.json(), { service: 'drive-worker-mcp', status: 'alive', configured: false,
    runtime: 'not_initialized', database: 'not_checked', authentication: 'not_ready', user_ready: false,
    google_callback_path: '/api/auth/callback/google' });
  for (const path of ['/mcp', '/api/auth/callback/google', '/connect', '/ui/connect', '/.well-known/oauth-authorization-server/api/auth']) {
    assert.equal((await deployment.fetch(request(path))).status, 503);
  }
  assert.equal(loads, 0);
});
test('concurrent requests share init; health verifies the database without claiming OAuth acceptance', async () => {
  let loads = 0, checks = 0;
  const deployment = createDeployment({ environment: () => env, load: async () => {
    loads++; return { ...ready(), checkDatabase: async () => { checks++; } };
  } });
  const results = await Promise.all([deployment.fetch(request('/health')), deployment.fetch(request('/connect'))]);
  const health = await results[0]!.json();
  assert.equal(loads, 1); assert.equal(checks, 1);
  assert.equal(health.configured, true); assert.equal(health.runtime, 'initialized');
  assert.equal(health.database, 'schema_present'); assert.equal(health.authentication, 'verification_pending');
  assert.equal(health.user_ready, false);
});
test('failed initialization is sanitized, shared, and retried only after cooldown', async () => {
  let time = 0, loads = 0;
  const deployment = createDeployment({ environment: () => env, now: () => time, load: async () => {
    loads++; if (loads === 1) throw new Error(`unsafe driver detail ${env.DATABASE_URL}`); return ready();
  } });
  const first = await deployment.fetch(request('/connect'));
  assert.equal(first.status, 503); assert.deepEqual(await first.json(), { error: 'AUTH_NOT_READY' });
  assert.equal((await deployment.fetch(request('/connect'))).status, 503); assert.equal(loads, 1);
  time = 30_000;
  assert.equal((await deployment.fetch(request('/connect'))).status, 200); assert.equal(loads, 2);
});
test('fresh health failure reports database unavailable despite an initialized runtime', async () => {
  const deployment = createDeployment({ environment: () => env, load: async () => ({ ...ready(),
    checkDatabase: async () => { throw new Error('synthetic database outage'); } }) });
  const response = await deployment.fetch(request('/health'));
  assert.equal(response.status, 503);
  const health = await response.json();
  assert.equal(health.runtime, 'initialized'); assert.equal(health.database, 'unavailable'); assert.equal(health.user_ready, false);
});
test('synchronous loader failure and missing schema also stay fail-closed and retry after cooldown', async () => {
  let time = 0, loads = 0;
  const deployment = createDeployment({ environment: () => env, now: () => time, load: () => {
    loads++; if (loads === 1) throw new AuthBoundaryError('AUTH_DATABASE_NOT_READY'); return Promise.resolve(ready());
  } });
  const response = await deployment.fetch(request('/health'));
  assert.equal(response.status, 503);
  const health = await response.json();
  assert.equal(health.runtime, 'unavailable'); assert.equal(health.database, 'unavailable');
  assert.equal((await deployment.fetch(request('/mcp'))).status, 503); assert.equal(loads, 1);
  time = 30_000;
  assert.equal((await deployment.fetch(request('/mcp'))).status, 200); assert.equal(loads, 2);
});
test('mount forwards exact auth/UI requests and preserves OAuth 401/403 challenges and cookies', async () => {
  const seen: Request[] = [];
  const deployment = createDeployment({ environment: () => env, load: async () => ({ ...ready(), fetch: async input => {
    seen.push(input);
    const headers = new Headers({ 'www-authenticate': 'Bearer error="insufficient_scope", scope="jobs:read"' });
    headers.append('set-cookie', 'a=fixture; HttpOnly'); headers.append('set-cookie', 'b=fixture; HttpOnly');
    return new Response(null, { status: seen.length === 1 ? 401 : 403, headers });
  } }) });
  for (const [index, path] of ['/api/auth/callback/google?code=synthetic', '/mcp', '/connect', '/ui/sign-in', '/ui/continue'].entries()) {
    const input = request(path);
    const response = await deployment.fetch(input);
    assert.equal(seen[index], input); assert.equal(response.status, index === 0 ? 401 : 403);
    assert.equal(response.headers.get('www-authenticate'), 'Bearer error="insufficient_scope", scope="jobs:read"');
    assert.deepEqual(response.headers.getSetCookie(), ['a=fixture; HttpOnly', 'b=fixture; HttpOnly']);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
});
test('invalid host/origin is rejected before init, unknown paths do not contact the database', async () => {
  let loads = 0;
  const deployment = createDeployment({ environment: () => env, load: async () => { loads++; return ready(); } });
  assert.equal((await deployment.fetch(new Request('https://evil.example.test/connect'))).status, 400);
  assert.equal((await deployment.fetch(new Request(`${origin}/mcp`, { headers: { origin: 'https://evil.example.test' } }))).status, 400);
  assert.equal((await deployment.fetch(request('/package.json'))).status, 404);
  assert.equal((await deployment.fetch(new Request(`${origin}/health`, { method: 'POST' }))).status, 405);
  assert.equal(loads, 0);
});
test('Vercel rewrite reaches every runtime form and keeps the public-only output boundary', async () => {
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8')) as {
    outputDirectory: string; installCommand: string; rewrites: { source: string; destination: string }[];
  };
  assert.equal(config.outputDirectory, 'public');
  assert.equal(config.installCommand, 'npm ci --ignore-scripts --no-audit --no-fund --registry https://registry.npmjs.org');
  for (const source of ['/health', '/mcp', '/api/auth/:path*', '/.well-known/:path*', '/connect', '/sign-in', '/consent', '/ui/:path*']) {
    assert.ok(config.rewrites.some(route => route.source === source && route.destination === '/api'));
  }
});
