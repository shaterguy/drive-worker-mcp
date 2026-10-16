import test from 'node:test';
import assert from 'node:assert/strict';
import { GoogleDrive } from '../src/google-drive.ts';
import { ServiceError, safeError } from '../src/errors.ts';
import { DriveWorkerService, normalizeCommand } from '../src/service.ts';
import { FakeStore } from './fakes.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const forbidden = (reasons: unknown[]) => JSON.stringify({ error: { errors: reasons.map(reason => ({ reason })) } });
const publicError = (error: unknown, context: 'read' | 'publication' = 'read') =>
  (safeError as (e: unknown, c?: string) => Record<string, unknown>)(error, context);
async function capture(call: () => Promise<unknown>) {
  try { await call(); } catch (error) { assert.ok(error instanceof ServiceError); return error; }
  assert.fail('Expected a service error');
}
function fixture(body: string, status = 403, diagnostics: { sink?: (line: string) => unknown; createId?: () => string } = {}) {
  const lines: string[] = []; const sleeps: number[] = []; let calls = 0;
  const options = { getAccessToken: async () => 'synthetic-token',
    fetch: async () => { calls++; return new Response(body, { status }); },
    sleep: async (ms: number) => { sleeps.push(ms); },
    diagnostics: { sink: (line: string) => { lines.push(line); }, ...diagnostics } };
  return { drive: new GoogleDrive(options), lines, sleeps, calls: () => calls };
}

test('unattributed, malformed, over-limit and ambiguous 403 never assert lost permissions', async () => {
  for (const body of ['not-json', '{}', 'null', '{"error":null}', '{"error":{"errors":{}}}',
    forbidden([]), forbidden(['forbidden']), forbidden(['insufficientFilePermissions-private']),
    forbidden(['insufficientPermissions', 'domainPolicy']), forbidden(['domainPolicy', 'unrecognized']),
    forbidden([42]), forbidden([null]), 'x'.repeat(16385)]) {
    const f = fixture(body); const e = await capture(() => f.drive.getMetadata('fixture-file'));
    assert.equal(e.code, 'UPSTREAM_FORBIDDEN_UNKNOWN');
    const safe = publicError(e);
    assert.equal(safe.category, 'upstream_forbidden_unknown'); assert.equal(safe.retryable, true);
    assert.match(String(safe.action), /same read/); assert.match(String(safe.action), /Do not submit/);
    assert.match(String(safe.correlation_id), UUID);
    assert.equal(f.calls(), 1); assert.deepEqual(f.sleeps, []);
  }
});

test('exact Google reason allowlist separates scope, rate, quota, permission, app and domain failures', async () => {
  for (const [reason, code, category, retryable] of [
    ['insufficientPermissions', 'INSUFFICIENT_SCOPE', 'scope', false],
    ['rateLimitExceeded', 'UPSTREAM_RATE_LIMITED', 'rate_limit', true],
    ['userRateLimitExceeded', 'UPSTREAM_RATE_LIMITED', 'rate_limit', true],
    ['dailyLimitExceeded', 'UPSTREAM_QUOTA_EXCEEDED', 'quota', false],
    ['storageQuotaExceeded', 'UPSTREAM_QUOTA_EXCEEDED', 'quota', false],
    ['activeItemCreationLimitExceeded', 'UPSTREAM_QUOTA_EXCEEDED', 'quota', false],
    ['teamDriveFileLimitExceeded', 'UPSTREAM_QUOTA_EXCEEDED', 'quota', false],
    ['numChildrenInNonRootLimitExceeded', 'UPSTREAM_QUOTA_EXCEEDED', 'quota', false],
    ['insufficientFilePermissions', 'DRIVE_PERMISSION_DENIED', 'permission', false],
    ['teamDriveMembershipRequired', 'DRIVE_PERMISSION_DENIED', 'permission', false],
    ['appNotAuthorizedToFile', 'DRIVE_APP_NOT_AUTHORIZED', 'app_access', false],
    ['domainPolicy', 'DRIVE_DOMAIN_POLICY', 'domain_policy', false],
  ] as const) {
    const f = fixture(forbidden([reason])); const e = await capture(() => f.drive.getMetadata('fixture-file'));
    const safe = publicError(e); assert.equal(e.code, code); assert.equal(safe.category, category);
    assert.equal(safe.retryable, retryable); assert.equal(f.calls(), 1); assert.deepEqual(f.sleeps, []);
    const line = JSON.parse(f.lines[0]!); assert.equal(line.reason, reason); assert.equal(line.code, code);
    assert.equal(line.correlation_id, safe.correlation_id);
  }
});

test('diagnostics have one closed-schema failure record and never copy provider payloads or IDs', async () => {
  const secret = 'SYNTHETIC_PRIVATE_UPSTREAM_MARKER';
  const body = JSON.stringify({ error: { errors: [{ reason: 'appNotAuthorizedToFile', message: secret,
    domain: secret, location: secret }], message: secret, token: secret, cause: secret }, correlation_id: secret });
  const f = fixture(body);
  const e = await capture(() => f.drive.findExact('fixture-folder', secret));
  assert.equal(f.lines.length, 1); const record = JSON.parse(f.lines[0]!);
  assert.deepEqual(Object.keys(record).sort(), ['event', 'operation', 'http_status', 'reason', 'code', 'correlation_id'].sort());
  assert.equal(record.event, 'dwmcp_upstream_v1'); assert.equal(record.operation, 'find_exact');
  assert.equal(record.http_status, 403); assert.match(record.correlation_id, UUID);
  assert.equal(publicError(e).correlation_id, record.correlation_id);
  const all = JSON.stringify([f.lines, publicError(e), e]);
  for (const value of [secret, 'fixture-folder', 'synthetic-token', 'www.googleapis.com']) assert.equal(all.includes(value), false);
  assert.ok(Buffer.byteLength(f.lines[0]!) <= 512);
  const malformed = fixture('bad-json'); await capture(() => malformed.drive.readBytes('fixture-file', 100));
  assert.equal(JSON.parse(malformed.lines[0]!).reason, 'unparseable');
  const unknown = fixture(forbidden(['untrusted-private-reason'])); await capture(() => unknown.drive.reserveFileId());
  assert.equal(JSON.parse(unknown.lines[0]!).reason, 'unknown');
  assert.equal(unknown.lines.join('').includes('untrusted-private-reason'), false);
});

test('all five adapter operations use fixed labels without file, folder or command data', async () => {
  const f = fixture('{}');
  for (const call of [() => f.drive.getMetadata('fixture-file'), () => f.drive.reserveFileId(),
    () => f.drive.createJson('fixture-file', 'fixture-folder', 'MANUAL-fixture.json', '{}'),
    () => f.drive.readBytes('fixture-file', 100), () => f.drive.findExact('fixture-folder', 'MANUAL-fixture.json')]) await capture(call);
  assert.deepEqual(f.lines.map(line => JSON.parse(line).operation), ['get_metadata', 'reserve_file_id', 'create_json', 'read_bytes', 'find_exact']);
});

test('a throwing or invalid ID generator and failing log sinks preserve the original error', async () => {
  for (const diagnostics of [
    { createId: () => { throw new Error('SYNTHETIC_ID_FAILURE'); } },
    { createId: () => 'not-a-uuid-private' },
    { sink: () => { throw new Error('SYNTHETIC_SINK_FAILURE'); } },
    { sink: async () => { throw new Error('SYNTHETIC_ASYNC_SINK_FAILURE'); } },
  ]) {
    const f = fixture(forbidden(['domainPolicy']), 403, diagnostics);
    const e = await capture(() => f.drive.getMetadata('fixture-file'));
    assert.equal(e.code, 'DRIVE_DOMAIN_POLICY'); assert.equal(publicError(e).category, 'domain_policy');
    assert.equal(f.calls(), 1); assert.equal(JSON.stringify(publicError(e)).includes('SYNTHETIC'), false);
    if ('createId' in diagnostics) { assert.equal(publicError(e).correlation_id, undefined); assert.equal(f.lines.length, 0); }
  }
  await new Promise(resolve => setImmediate(resolve));
});

test('concurrent failures have independent correlation IDs and match their own operation', async () => {
  const f = fixture(forbidden(['rateLimitExceeded']));
  const errors = await Promise.all(Array.from({ length: 13 }, (_, i) => capture(i % 2
    ? () => f.drive.getMetadata('fixture-file') : () => f.drive.readBytes('fixture-file', 100))));
  assert.equal(f.lines.length, 13); assert.equal(new Set(errors.map(e => publicError(e).correlation_id)).size, 13);
  for (const [i, error] of errors.entries()) {
    const record = f.lines.map(line => JSON.parse(line)).find(line => line.correlation_id === publicError(error).correlation_id);
    assert.equal(record.operation, i % 2 ? 'get_metadata' : 'read_bytes');
  }
});

test('transient retry bounds and final HTTP status remain unchanged, with one terminal record', async () => {
  for (const status of [429, 500, 503]) {
    const f = fixture('SYNTHETIC_PRIVATE_BODY', status);
    const e = await capture(() => f.drive.reserveFileId());
    assert.equal(e.code, status === 429 ? 'UPSTREAM_RATE_LIMITED' : 'UPSTREAM_UNAVAILABLE');
    assert.equal(f.calls(), 3); assert.deepEqual(f.sleeps, [250, 500]);
    assert.equal(f.lines.length, 1); assert.equal(JSON.parse(f.lines[0]!).http_status, status);
    assert.equal(publicError(e).correlation_id, JSON.parse(f.lines[0]!).correlation_id);
  }
  const lines: string[] = []; const sleeps: number[] = []; let n = 0;
  const options = { getAccessToken: async () => 'synthetic-token', diagnostics: { sink: (line: string) => lines.push(line) },
    sleep: async (ms: number) => { sleeps.push(ms); }, fetch: async () => ++n === 1
      ? new Response('', { status: 429, headers: { 'retry-after': '1' } }) : Response.json({ ids: ['fixture-file'] }) };
  assert.equal(await new GoogleDrive(options).reserveFileId(), 'fixture-file');
  assert.deepEqual(sleeps, [1000]); assert.deepEqual(lines, []);
  let networkCalls = 0; const networkSleeps: number[] = [];
  const network = new GoogleDrive({ getAccessToken: async () => 'synthetic-token',
    fetch: async () => { networkCalls++; throw new Error('SYNTHETIC_NETWORK_SECRET'); },
    sleep: async ms => { networkSleeps.push(ms); } });
  assert.equal((await capture(() => network.reserveFileId())).code, 'UPSTREAM_UNAVAILABLE');
  assert.equal(networkCalls, 3); assert.deepEqual(networkSleeps, [250, 500]);
});

test('publication failures keep UNKNOWN and safe cause while forbidding blind retry or new job creation', async () => {
  for (const reason of ['unrecognized', 'appNotAuthorizedToFile', 'domainPolicy', 'dailyLimitExceeded']) {
    const store = new FakeStore(); store.bindings.set('fixture-account', { accountId: 'fixture-account', manualFolderId: 'manual', commandsFolderId: 'commands', resultsFolderId: 'results' });
    const lines: string[] = []; let posts = 0, reserves = 0;
    const options = { getAccessToken: async () => 'synthetic-token', diagnostics: { sink: (line: string) => lines.push(line) },
      fetch: async (url: string | URL, init?: RequestInit) => {
        const u = new URL(String(url));
        if (u.pathname.endsWith('/manual')) return Response.json({ id: 'manual', name: 'manual', mimeType: 'application/vnd.google-apps.folder', capabilities: { canAddChildren: true } });
        if (u.pathname.endsWith('/generateIds')) { reserves++; return Response.json({ ids: ['fixture-fixed-id'] }); }
        if (init?.method === 'POST') { posts++; return new Response(forbidden([reason]), { status: 403 }); }
        return new Response('{}', { status: 404 });
      } };
    const service = new DriveWorkerService({ store, driveForAccount: async () => new GoogleDrive(options), assertActiveGrant: async () => {}, cursorKey: new Uint8Array(32).fill(7) });
    const p = { accountId: 'fixture-account', clientId: 'fixture-client', grantId: 'fixture-grant', scopes: new Set<'manual:publish'>(['manual:publish']) };
    const e = await capture(() => service.publishManual(p, { job_id: 'MANUAL-fixture', command: 'printf harmless', cwd: '/tmp', timeout_ms: 1000 }));
    const safe = publicError(e, 'publication');
    assert.equal(e.code, 'SUBMISSION_OUTCOME_UNKNOWN'); assert.equal(safe.retryable, false);
    assert.equal(safe.category, 'submission_unknown'); assert.ok(safe.upstream_code);
    assert.equal(safe.correlation_id, JSON.parse(lines[0]!).correlation_id);
    assert.match(String(safe.action), /identical job_id, body and route/); assert.match(String(safe.action), /Do not create a new job/);
    assert.equal((await store.getPublication('fixture-account', 'MANUAL-fixture'))?.state, 'UNKNOWN');
    assert.equal(posts, 1); assert.equal(reserves, 1);
  }
});

test('a fixed-ID create followed by an unknown403 reconciliation read never allocates another ID', async () => {
  const store = new FakeStore(); store.bindings.set('fixture-account', { accountId: 'fixture-account', manualFolderId: 'manual', commandsFolderId: 'commands', resultsFolderId: 'results' });
  const command = { job_id: 'MANUAL-reconcile', command: 'printf harmless', cwd: '/tmp', timeout_ms: 1000 };
  let exists = false, denyOnce = true, posts = 0, reserves = 0; const lines: string[] = [];
  const options = { getAccessToken: async () => 'synthetic-token', diagnostics: { sink: (line: string) => lines.push(line) },
    fetch: async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      if (u.pathname.endsWith('/manual')) return Response.json({ id: 'manual', name: 'manual', mimeType: 'application/vnd.google-apps.folder', capabilities: { canAddChildren: true } });
      if (u.pathname.endsWith('/generateIds')) { reserves++; return Response.json({ ids: ['fixture-fixed-id'] }); }
      if (init?.method === 'POST') { posts++; exists = true; return Response.json({ id: 'fixture-fixed-id' }); }
      if (!exists) return new Response('{}', { status: 404 });
      if (denyOnce) { denyOnce = false; return new Response('{}', { status: 403 }); }
      if (u.searchParams.get('alt') === 'media') return new Response(normalizeCommand(command, 'manual').json);
      return Response.json({ id: 'fixture-fixed-id', name: command.job_id + '.json', parents: ['manual'], mimeType: 'application/json', createdTime: '2026-01-01T00:00:00.000Z', version: '1' });
    } };
  const service = new DriveWorkerService({ store, driveForAccount: async () => new GoogleDrive(options), assertActiveGrant: async () => {}, cursorKey: new Uint8Array(32).fill(7) });
  const p = { accountId: 'fixture-account', clientId: 'fixture-client', grantId: 'fixture-grant', scopes: new Set<'manual:publish'>(['manual:publish']) };
  const e = await capture(() => service.publishManual(p, command));
  assert.equal(e.code, 'SUBMISSION_OUTCOME_UNKNOWN'); assert.equal(publicError(e, 'publication').upstream_code, 'UPSTREAM_FORBIDDEN_UNKNOWN');
  assert.equal(publicError(e, 'publication').correlation_id, JSON.parse(lines[0]!).correlation_id);
  assert.equal((await service.publishManual(p, command)).publication_status, 'PUBLISHED');
  assert.equal(posts, 1); assert.equal(reserves, 1);
});
