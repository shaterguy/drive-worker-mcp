import test from 'node:test';
import assert from 'node:assert/strict';
import { GoogleDrive } from '../src/google-drive.ts';

test('Google adapter reserves IDs and creates multipart JSON with that exact ID and parent', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const drive = new GoogleDrive({ getAccessToken: async () => 'fixture-token',
    fetch: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify(String(url).includes('generateIds') ? { ids: ['fixed-id'] } : { id: 'fixed-id' }));
    } });
  assert.equal(await drive.reserveFileId(), 'fixed-id');
  await drive.createJson('fixed-id', 'folder-id', 'MANUAL-J.json', '{"safe":true}');
  assert.equal(calls[1]?.init.method, 'POST');
  assert.equal(new URL(calls[1]!.url).host, 'www.googleapis.com');
  assert.ok(String(calls[1]?.init.body).includes('"id":"fixed-id"'));
  assert.ok(String(calls[1]?.init.body).includes('"parents":["folder-id"]'));
});
test('Google 409 surfaces as a fixed-ID reconciliation condition, never a new ID', async () => {
  const drive = new GoogleDrive({ getAccessToken: async () => 'fixture-token', fetch: async () => new Response('{}', { status: 409 }) });
  await assert.rejects(drive.createJson('fixed-id', 'folder-id', 'x.json', '{}'), (e: unknown) => {
    return !!e && typeof e === 'object' && 'code' in e && e.code === 'DRIVE_FILE_EXISTS';
  });
});
test('download cap is enforced against actual streamed bytes even when content-length lies', async () => {
  let cancelled = false;
  const drive = new GoogleDrive({ getAccessToken: async () => 'fixture-token', fetch: async () => new Response(new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(128)); c.enqueue(new Uint8Array(128)); }, cancel() { cancelled = true; }
  }), { headers: { 'content-length': '1' } }) });
  await assert.rejects(drive.readBytes('file-id', 200), (e: unknown) => !!e && typeof e === 'object' && 'code' in e && e.code === 'UPSTREAM_TOO_LARGE');
  assert.equal(cancelled, true);
});
test('only transient statuses retry and Retry-After is respected without logging upstream bodies', async () => {
  let n = 0; const sleeps: number[] = [];
  const drive = new GoogleDrive({ getAccessToken: async () => 'fixture-token', sleep: async ms => { sleeps.push(ms); },
    fetch: async () => ++n < 2 ? new Response('private-upstream-body', { status: 429, headers: { 'retry-after': '1' } }) : new Response('{"ids":["fixed-id"]}') });
  assert.equal(await drive.reserveFileId(), 'fixed-id'); assert.deepEqual(sleeps, [1000]);
  const denied = new GoogleDrive({ getAccessToken: async () => 'fixture-token', fetch: async () => new Response('private-upstream-body', { status: 403 }) });
  await assert.rejects(denied.getMetadata('file-id'), (e: unknown) => {
    assert.equal(String(e).includes('private-upstream-body'), false);
    return !!e && typeof e === 'object' && 'code' in e && e.code === 'DRIVE_PERMISSION_DENIED';
  });
});
test('exact-name query handles pagination and preserves duplicates rather than selecting latest', async () => {
  let n = 0;
  const drive = new GoogleDrive({ getAccessToken: async () => 'fixture-token', fetch: async (url) => {
    assert.ok(new URL(String(url)).searchParams.get('q')?.includes("'folder-id' in parents"));
    return new Response(JSON.stringify(++n === 1 ? { files: [], nextPageToken: 'page2' } : {
      files: [{ id: 'a', name: 'x.json', mimeType: 'application/json' }, { id: 'b', name: 'x.json', mimeType: 'application/json' }] }));
  } });
  assert.equal((await drive.findExact('folder-id', 'x.json')).length, 2); assert.equal(n, 2);
});

test('service reconciles a real adapter 409 by exact reserved-ID metadata and body hash', async () => {
  const { DriveWorkerService, normalizeCommand } = await import('../src/service.ts');
  const { FakeStore } = await import('./fakes.ts');
  const store = new FakeStore();
  store.bindings.set('a', { accountId: 'a', manualFolderId: 'manual', commandsFolderId: 'commands', resultsFolderId: 'results' });
  const command = { job_id: 'MANUAL-409', command: 'printf harmless', cwd: '/tmp', timeout_ms: 1000 };
  let exists = false, reserves = 0, posts = 0;
  const drive = new GoogleDrive({ getAccessToken: async () => 'fixture-token', fetch: async (url, init) => {
    const u = new URL(String(url));
    if (u.pathname.endsWith('/generateIds')) { reserves++; return Response.json({ ids: ['fixed-id'] }); }
    if (init?.method === 'POST') { posts++; exists = true; return Response.json({}, { status: 409 }); }
    if (u.pathname.endsWith('/manual')) return Response.json({ id: 'manual', name: 'manual',
      mimeType: 'application/vnd.google-apps.folder', capabilities: { canAddChildren: true } });
    if (!exists) return Response.json({}, { status: 404 });
    if (u.searchParams.get('alt') === 'media') return new Response(normalizeCommand(command, 'manual').json);
    return Response.json({ id: 'fixed-id', name: 'MANUAL-409.json', parents: ['manual'],
      mimeType: 'application/json', createdTime: '2026-01-01T00:00:00.000Z', version: '1' });
  } });
  const service = new DriveWorkerService({ store, driveForAccount: async () => drive,
    assertActiveGrant: async () => {}, cursorKey: new Uint8Array(32).fill(3) });
  const principal = { accountId: 'a', grantId: 'fixture-grant', clientId: 'fixture-client', scopes: new Set<'manual:publish'>(['manual:publish']) };
  const result = await service.publishManual(principal, command);
  assert.equal(result.command_file_id, 'fixed-id'); assert.equal(result.publication_status, 'PUBLISHED');
  await service.publishManual(principal, command);
  assert.equal(reserves, 1); assert.equal(posts, 1);
});
