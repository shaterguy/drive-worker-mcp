import test from 'node:test';
import assert from 'node:assert/strict';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { symmetricDecrypt } from 'better-auth/crypto';
import { createSchemaOptions } from '../scripts/schema-config.ts';

function fixture() {
  // MemoryAdapter requires empty collections to exist before its first findMany.
  const memory: Record<string, Record<string, unknown>[]> = {
    user: [], session: [], account: [], verification: [], jwks: [], oauthAccessToken: [],
    oauthClient: [], oauthClientAssertion: [], oauthClientResource: [], oauthConsent: [],
    oauthRefreshToken: [], oauthResource: [],
  };
  const options = createSchemaOptions(memoryAdapter(memory));
  const auth = betterAuth({ ...options,
    // Keep the exact JWT/MCP/CIMD plugins; omit Google discovery in this memory-only fixture.
    plugins: options.plugins.filter(plugin => plugin.id !== 'generic-oauth'),
  });
  return { auth, memory };
}

test('maintained JWT init creates no key; first JWKS persists an encrypted Ed25519 private key', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('UNEXPECTED_FIXTURE_NETWORK'); });
  const { auth, memory } = fixture();
  const context = await auth.$context;
  assert.equal(memory.jwks?.length ?? 0, 0);
  const response = await auth.handler(new Request('https://schema-only.invalid/api/auth/jwks'));
  assert.equal(response.status, 200);
  assert.equal(memory.jwks?.length, 1);
  const stored = memory.jwks?.[0]; assert.ok(stored);
  assert.equal(stored.alg, 'EdDSA'); assert.equal(stored.crv, 'Ed25519');
  assert.equal(stored.expiresAt == null, true); // no configured automatic rotation interval
  if (typeof stored.privateKey !== 'string' || typeof stored.publicKey !== 'string') throw new Error('KEY_STORAGE_TYPE_INVALID');
  const ciphertext: unknown = JSON.parse(stored.privateKey);
  if (typeof ciphertext !== 'string') throw new Error('PRIVATE_KEY_NOT_ENCRYPTED');
  assert.equal(/^\$ba\$\d+\$[0-9a-f]+$/.test(ciphertext), true);
  const plain = JSON.parse(await symmetricDecrypt({ key: context.secretConfig, data: ciphertext })) as Record<string, unknown>;
  assert.equal(plain.kty, 'OKP'); assert.equal(plain.crv, 'Ed25519'); assert.equal(typeof plain.d, 'string');
  assert.equal(stored.privateKey.includes('"d"'), false);
  assert.equal(Object.hasOwn(JSON.parse(stored.publicKey) as object, 'd'), false);
  const output = await response.json() as { keys: Record<string, unknown>[] };
  assert.equal(output.keys.length, 1); assert.equal(output.keys[0]?.alg, 'EdDSA');
  assert.equal(Object.hasOwn(output.keys[0]!, 'd'), false);
  await auth.handler(new Request('https://schema-only.invalid/api/auth/jwks'));
  assert.equal(memory.jwks?.length, 1); // sequential reuse, not an exactly-one concurrency claim
});

test('first maintained signing call also lazy-creates a key when no JWKS request occurred', async t => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('UNEXPECTED_FIXTURE_NETWORK'); });
  const { auth, memory } = fixture();
  await auth.$context;
  assert.equal(memory.jwks?.length ?? 0, 0);
  const signed = await auth.api.signJWT({ body: { payload: { sub: 'synthetic-fixture-subject' } } });
  assert.equal(memory.jwks?.length, 1);
  const header = JSON.parse(Buffer.from(signed.token.split('.')[0]!, 'base64url').toString('utf8')) as Record<string, unknown>;
  assert.equal(header.alg, 'EdDSA'); assert.equal(header.kid === memory.jwks?.[0]?.id, true);
});
