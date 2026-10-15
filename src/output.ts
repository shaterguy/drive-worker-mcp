import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { fail } from './errors.ts';

export function digest(text: string): string { return createHash('sha256').update(text).digest('hex'); }
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return '{' + Object.keys(obj).sort().map(k => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
  }
  const result = JSON.stringify(value);
  if (result === undefined) fail('INVALID_COMMAND');
  return result;
}
/** Defense in depth, not a promise to recognize arbitrary secret strings. */
export function redact(text: string): string {
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[REDACTED_PRIVATE_KEY]')
    .replace(/\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s"'<>]+/gi, '[REDACTED_CONNECTION_URI]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.~-]+/gi, '[REDACTED_AUTHORIZATION]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED_JWT]')
    .replace(/\b(?:ya29\.[A-Za-z0-9._-]+|1\/\/[A-Za-z0-9_-]+|AIza[A-Za-z0-9_-]{25,}|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{16,})\b/g, '[REDACTED_TOKEN]')
    .replace(/((?:["']?)(?:access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|api[_-]?key|password|passwd|authorization|cookie|set-cookie|database_url|secret|private[_-]?key)(?:["']?)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi, '$1[REDACTED]');
}
interface Cursor { version: 1; binding: string; offset: number }
export function pageText(text: string, binding: string, key: Uint8Array, limit: number, cursor?: string) {
  const bytes = Buffer.from(text, 'utf8');
  let offset = 0;
  const sign = (payload: string) => createHmac('sha256', key).update(payload).digest('base64url');
  if (cursor !== undefined) {
    if (cursor.length > 2048) fail('CURSOR_INVALID');
    const parts = cursor.split('.');
    const payload = parts[0], supplied = parts[1];
    if (parts.length !== 2 || !payload || !supplied || !/^[A-Za-z0-9_-]+$/.test(payload + supplied)) fail('CURSOR_INVALID');
    const expected = Buffer.from(sign(payload)); const got = Buffer.from(supplied);
    if (expected.length !== got.length || !timingSafeEqual(expected, got)) fail('CURSOR_INVALID');
    let parsed: Cursor;
    try { parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Cursor; }
    catch { return fail('CURSOR_INVALID'); }
    if (parsed.version !== 1 || parsed.binding !== binding || !Number.isSafeInteger(parsed.offset)
      || parsed.offset < 0 || parsed.offset > bytes.length) fail('CURSOR_INVALID');
    offset = parsed.offset;
    if (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) fail('CURSOR_INVALID');
  }
  let end = Math.min(offset + limit, bytes.length);
  while (end > offset && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  let next: string | null = null;
  if (end < bytes.length) {
    const payload = Buffer.from(JSON.stringify({ version: 1, binding, offset: end } satisfies Cursor)).toString('base64url');
    next = payload + '.' + sign(payload);
  }
  return { text: bytes.subarray(offset, end).toString('utf8'), next_cursor: next, bytes_returned: end - offset,
    total_redacted_bytes: bytes.length };
}
