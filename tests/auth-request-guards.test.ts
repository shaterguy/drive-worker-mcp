import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRequestOrigin, boundedRequest, noStore } from '../src/auth/request-guards.ts';

const origin = 'https://verified.example.test';
test('request host and browser Origin cannot override the configured origin', () => {
  assertRequestOrigin(new Request(`${origin}/mcp`), { origin });
  for (const headers of [{ host: 'evil.example.test' }, { origin: 'https://evil.example.test' }, { origin: 'null' }]) {
    assert.throws(() => assertRequestOrigin(new Request(`${origin}/mcp`, { headers }), { origin }));
  }
  assert.throws(() => assertRequestOrigin(new Request('https://evil.example.test/mcp'), { origin }));
  assertRequestOrigin(new Request(`${origin}/mcp`, { headers: { 'x-forwarded-host': 'evil.example.test' } }), { origin });
});
test('body bound is enforced without trusting Content-Length', async () => {
  const input = new Request(`${origin}/mcp`, { method: 'POST', body: '12345', headers: { 'content-length': '1' } });
  await assert.rejects(boundedRequest(input, 4), { message: 'REQUEST_TOO_LARGE' });
  const small = await boundedRequest(new Request(`${origin}/mcp`, { method: 'POST', body: '1234' }), 4);
  assert.equal(await small.text(), '1234');
});
test('noStore clones redirect headers and preserves multiple auth cookies',()=>{
  const redirect=noStore(Response.redirect(`${origin}/sign-in`,303));
  assert.equal(redirect.status,303);
  assert.equal(redirect.headers.get('location'),`${origin}/sign-in`);
  assert.equal(redirect.headers.get('cache-control'),'no-store');
  const headers=new Headers();headers.append('set-cookie','a=1; HttpOnly');headers.append('set-cookie','b=2; HttpOnly');
  const authResponse=noStore(new Response('{}',{headers}));
  assert.deepEqual(authResponse.headers.getSetCookie(),['a=1; HttpOnly','b=2; HttpOnly']);
});
