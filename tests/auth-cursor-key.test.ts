import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveCursorKey } from '../src/auth/cursor-key.ts';
import { pageText } from '../src/output.ts';

const config = { secret: 'synthetic-fixture-secret-not-for-production-2026', resource: 'https://verified.example.test/mcp' };
test('cursor HKDF is deterministic, 32 bytes, and purpose/environment separated', () => {
  const key = deriveCursorKey(config);
  assert.equal(key.byteLength, 32);
  assert.deepEqual(deriveCursorKey(config), key);
  assert.notDeepEqual(key, Buffer.from(config.secret));
  assert.notDeepEqual(deriveCursorKey({ ...config, resource: 'https://other.example.test/mcp' }), key);
  assert.notDeepEqual(deriveCursorKey({ ...config, secret: config.secret + 'rotated' }), key);
  assert.throws(() => deriveCursorKey({ ...config, secret: 'short' }));
});
test('same secret/resource resumes cursors after restart; rotation or another resource rejects them', () => {
  const first = pageText('abcdefghij', 'tenant/file/content-hash', deriveCursorKey(config), 3);
  assert.ok(first.next_cursor);
  const cursor = first.next_cursor;
  assert.equal(pageText('abcdefghij', 'tenant/file/content-hash', deriveCursorKey(config), 3, cursor).text, 'def');
  for (const changed of [{ ...config, secret: config.secret + 'rotated' },
    { ...config, resource: 'https://other.example.test/mcp' }]) {
    assert.throws(() => pageText('abcdefghij', 'tenant/file/content-hash', deriveCursorKey(changed), 3, cursor),
      { message: 'CURSOR_INVALID' });
  }
});
