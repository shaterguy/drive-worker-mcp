import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { pageText, redact } from '../src/output.ts';

const key = new Uint8Array(32).fill(5);
function cursor(binding: string, offset: unknown) {
  const body = Buffer.from(JSON.stringify({ version: 1, binding, offset })).toString('base64url');
  return body + '.' + createHmac('sha256', key).update(body).digest('base64url');
}
test('signed cursors reject tampering, tenant binding changes, invalid offsets and UTF-8 midpoints', () => {
  const text = '한글🙂'.repeat(100); const page = pageText(text, 'tenant-a/job/log', key, 256);
  assert.ok(page.next_cursor); assert.equal(page.text.includes('\ufffd'), false);
  assert.throws(() => pageText(text, 'tenant-b/job/log', key, 256, page.next_cursor!));
  assert.throws(() => pageText(text, 'tenant-a/job/log', key, 256, page.next_cursor!.slice(0, -1) + '!'));
  for (const offset of [-1, 1.5, 999999, 1, null]) {
    assert.throws(() => pageText(text, 'tenant-a/job/log', key, 256, cursor('tenant-a/job/log', offset)));
  }
  let all = page.text; let next: string | null = page.next_cursor;
  while (next) { const p = pageText(text, 'tenant-a/job/log', key, 256, next); all += p.text; next = p.next_cursor; }
  assert.equal(all, text);
});
test('whole-text redaction prevents credential fragments leaking across page boundaries', () => {
  const secrets = ['Bearer TEST_AUTH_CREDENTIAL', 'refresh_token=TEST_REFRESH_CREDENTIAL',
    'postgresql://test:TEST_DATABASE_CREDENTIAL@db.example.test/database',
    '-----BEGIN PRIVATE KEY-----\nTEST_SIGNING_CREDENTIAL\n-----END PRIVATE KEY-----'];
  const clean = redact('x'.repeat(252) + '\n' + secrets.join('\n') + '\n' + 'y'.repeat(300));
  assert.equal(clean.includes('TEST_'), false);
  assert.equal(redact('ordinary program output'), 'ordinary program output');
});
