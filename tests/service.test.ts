import test from 'node:test';
import assert from 'node:assert/strict';
import { DriveWorkerService, normalizeCommand } from '../src/service.ts';
import { FakeDrive, FakeStore } from './fakes.ts';
import type { Principal, ToolScope } from '../src/contracts.ts';

const command = { job_id: 'MANUAL-TEST-1', command: 'printf harmless', cwd: '/tmp', timeout_ms: 1000 };
function setup() {
  const store = new FakeStore();
  const drives = new Map<string, FakeDrive>();
  for (const a of ['a', 'b']) {
    const d = new FakeDrive(); drives.set(a, d);
    const binding = { accountId: a, manualFolderId: `${a}-manual`, commandsFolderId: `${a}-commands`, resultsFolderId: `${a}-results` };
    store.bindings.set(a, binding);
    for (const id of [binding.manualFolderId, binding.commandsFolderId, binding.resultsFolderId]) d.folder(id);
  }
  const p: Principal = { accountId: 'a', grantId: 'fixture-grant', clientId: 'fixture-client', scopes: new Set<ToolScope>(['manual:publish', 'jobs:submit', 'jobs:read']) };
  const service = new DriveWorkerService({ store, driveForAccount: async a => drives.get(a)!,
    assertActiveGrant: async () => {}, cursorKey: new Uint8Array(32).fill(7) });
  return { store, drives, drive: drives.get('a')!, service, p };
}
function code(expected: string) { return (e: unknown) => !!e && typeof e === 'object' && 'code' in e && e.code === expected; }

test('command normalization is stable across key order and refuses unknown destinations', () => {
  const a = normalizeCommand({ ...command, env: { B: '2', A: '1' } }, 'manual');
  const b = normalizeCommand({ env: { A: '1', B: '2' }, ...command }, 'manual');
  assert.equal(a.json, b.json); assert.equal(a.hash, b.hash);
  assert.throws(() => normalizeCommand({ ...command, folder_id: 'evil' }, 'manual'), code('INVALID_COMMAND'));
  assert.throws(() => normalizeCommand({ ...command, job_id: '../bad' }, 'manual'), code('INVALID_COMMAND'));
  assert.throws(() => normalizeCommand({ ...command, job_id: 'ordinary' }, 'manual'), code('INVALID_COMMAND'));
});
test('manual publication creates exactly one JSON in the manual folder and never claims execution', async () => {
  const { service, drive, p } = setup();
  const r = await service.publishManual(p, command);
  assert.equal(r.publication_status, 'PUBLISHED'); assert.equal(r.execution_status, 'AWAITING_MANUAL');
  assert.deepEqual(drive.writes, ['a-manual']);
  const f = drive.files.get(r.command_file_id)!;
  assert.equal(f.meta.mimeType, 'application/json'); assert.equal(f.meta.name, `${command.job_id}.json`);
  assert.equal(JSON.parse(new TextDecoder().decode(f.bytes)).schema, 'drive-worker-command-v1');
});
test('direct requires distinct jobs:submit scope and writes only to Commands', async () => {
  const { service, drive, p } = setup();
  await assert.rejects(service.submitDirect({ ...p, scopes: new Set(['manual:publish']) }, command), code('INSUFFICIENT_SCOPE'));
  const r = await service.submitDirect(p, command);
  assert.equal(r.publication_status, 'SUBMITTED'); assert.equal(r.execution_status, 'SUBMITTED_UNCONFIRMED');
  assert.deepEqual(drive.writes, ['a-commands']);
});
test('concurrent identical requests converge on one Drive file', async () => {
  const { service, drive, p } = setup();
  const results = await Promise.all(Array.from({ length: 20 }, () => service.publishManual(p, command)));
  assert.equal(new Set(results.map(r => r.command_file_id)).size, 1); assert.equal(drive.writes.length, 1);
});
test('lost create response reconciles the fixed ID without making a second file', async () => {
  const { service, drive, p } = setup(); drive.loseResponseOnce = true;
  const r = await service.publishManual(p, command);
  assert.equal(r.publication_status, 'PUBLISHED'); assert.equal(drive.writes.length, 1);
  await service.publishManual(p, command); assert.equal(drive.writes.length, 1);
});
test('DB failure after Drive create preserves the pre-reserved ID for retry', async () => {
  const { service, drive, store, p } = setup(); store.failStateOnce = true;
  await assert.rejects(service.publishManual(p, command), code('SUBMISSION_OUTCOME_UNKNOWN'));
  const r = await service.publishManual(p, command);
  assert.equal(r.publication_status, 'PUBLISHED'); assert.equal(drive.writes.length, 1);
});
test('route and body changes conflict and never promote a manual file', async () => {
  const { service, drive, p } = setup(); await service.publishManual(p, command);
  await assert.rejects(service.submitDirect(p, command), code('IDEMPOTENCY_CONFLICT'));
  await assert.rejects(service.publishManual(p, { ...command, command: 'different' }), code('IDEMPOTENCY_CONFLICT'));
  assert.deepEqual(drive.writes, ['a-manual']);
});
test('same job ID in two accounts has independent bindings and publications', async () => {
  const { service, drives, p } = setup();
  await service.publishManual(p, command); await service.publishManual({ ...p, accountId: 'b' }, command);
  assert.deepEqual(drives.get('a')!.writes, ['a-manual']); assert.deepEqual(drives.get('b')!.writes, ['b-manual']);
});
test('missing, overlapping, and unwritable bindings fail before any publication', async () => {
  const { service, store, drive, p } = setup();
  await assert.rejects(service.publishManual({ ...p, accountId: 'other' }, command), code('FOLDER_BINDING_REQUIRED'));
  store.bindings.get('a')!.commandsFolderId = 'a-manual';
  await assert.rejects(service.publishManual(p, command), code('FOLDER_UNAVAILABLE'));
  store.bindings.get('a')!.commandsFolderId = 'a-commands'; drive.folder('a-manual', false);
  await assert.rejects(service.publishManual(p, command), code('FOLDER_UNAVAILABLE')); assert.equal(drive.writes.length, 0);
});
test('status without Result distinguishes manual and direct without mutating files', async () => {
  const { service, drive, p } = setup(); await service.publishManual(p, command);
  const r = await service.getStatus(p, { job_id: command.job_id });
  assert.equal(r.execution_status, 'AWAITING_MANUAL'); assert.equal(r.source, 'publication');
  assert.equal(drive.writes.length, 1);
});
test('duplicate Results are an explicit conflict', async () => {
  const { service, drive, p } = setup();
  drive.put('r1', 'MANUAL-TEST-1.json', 'a-results', '{}', 'application/json');
  drive.put('r2', 'MANUAL-TEST-1.json', 'a-results', '{}', 'application/json');
  await assert.rejects(service.getStatus(p, { job_id: command.job_id }), code('RESULT_CONFLICT'));
});
test('schema, job ID and publication file mismatch are refused', async () => {
  const { service, drive, p } = setup(); await service.publishManual(p, command);
  for (const body of [{}, { schema: 'drive-worker-result-v1', job_id: 'other', status: 'DONE' },
    { schema: 'drive-worker-result-v1', job_id: command.job_id, command_file_id: 'unrelated', status: 'DONE' }]) {
    drive.put('r', `${command.job_id}.json`, 'a-results', JSON.stringify(body), 'application/json');
    await assert.rejects(service.getStatus(p, { job_id: command.job_id }), code('RESULT_INVALID'));
  }
});
test('all Worker statuses and execution uncertainty are retained without inferring success', async () => {
  const { service, drive, p } = setup();
  for (const status of ['CLAIMED', 'RUNNING', 'DONE', 'FAILED', 'ERROR', 'TIMED_OUT', 'INVALID']) {
    drive.put('r', `${command.job_id}.json`, 'a-results', JSON.stringify({ schema: 'drive-worker-result-v1',
      job_id: command.job_id, status, executor_host: 'executor-test', execution_outcome_uncertain: true }), 'application/json');
    const r = await service.getStatus(p, { job_id: command.job_id });
    assert.equal(r.execution_status, status); assert.equal(r.execution_outcome_uncertain, true); assert.equal(r.executor_host, 'executor-test');
  }
});
test('log references must be in bound Results with the exact job and stream name', async () => {
  const { service, drive, p } = setup();
  drive.put('r', `${command.job_id}.json`, 'a-results', JSON.stringify({ schema: 'drive-worker-result-v1',
    job_id: command.job_id, status: 'DONE', stdout_file_id: 'evil' }), 'application/json');
  drive.put('evil', `${command.job_id}.stdout.txt`, 'b-results', 'do not expose');
  await assert.rejects(service.getResult(p, { job_id: command.job_id, stream: 'stdout' }), code('RESULT_INVALID'));
  assert.equal(drive.reads.includes('evil'), false);
});
test('pagination returns bounded redacted output and rejects a stale cursor', async () => {
  const { service, drive, p } = setup();
  drive.put('r', `${command.job_id}.json`, 'a-results', JSON.stringify({ schema: 'drive-worker-result-v1',
    job_id: command.job_id, status: 'DONE', stdout_file_id: 'log', exit_code: 0 }), 'application/json');
  drive.put('log', `${command.job_id}.stdout.txt`, 'a-results', 'access_token=TEST_PRIVATE_TOKEN\n' + 'a'.repeat(700));
  const r = await service.getResult(p, { job_id: command.job_id, stream: 'stdout', limit: 256 });
  assert.equal(JSON.stringify(r).includes('TEST_PRIVATE_TOKEN'), false);
  assert.ok(Buffer.byteLength(String(r.text)) <= 256); assert.ok(r.next_cursor);
  const next = await service.getResult(p, { job_id: command.job_id, stream: 'stdout', limit: 256, cursor: r.next_cursor });
  assert.ok(next.text);
  drive.put('log', `${command.job_id}.stdout.txt`, 'a-results', 'changed');
  await assert.rejects(service.getResult(p, { job_id: command.job_id, stream: 'stdout', cursor: r.next_cursor }), code('CURSOR_INVALID'));
});

test('revoked grant and unavailable grant database fail before any Drive access on every tool', async () => {
  const { service, drive, p } = setup(); let checks = 0;
  service.deps.assertActiveGrant = async () => { checks++; throw new Error('fixture database or grant failure'); };
  for (const call of [() => service.publishManual(p, command), () => service.submitDirect(p, command),
    () => service.getStatus(p, { job_id: command.job_id }), () => service.getResult(p, { job_id: command.job_id })]) {
    await assert.rejects(call(), code('AUTH_REQUIRED'));
  }
  assert.equal(checks, 4); assert.equal(drive.reserved, 0); assert.equal(drive.reads.length, 0); assert.equal(drive.writes.length, 0);
});

test('Worker routed copy is verified using immutable publication digest without exposing command data', async () => {
  const { service, drive, p } = setup();
  const input = { ...command, target_server: 'AUTO', env: { PRIVATE_MARKER: 'never-display-me' }, stdin: 'never-display-stdin' };
  const publication = await service.submitDirect(p, input);
  const routed = { ...normalizeCommand(input, 'direct').body, target_server: 'standby one',
    origin_command_file_id: publication.command_file_id, origin_command_created_at: '2026-01-01T00:00:00.000Z' };
  drive.put('routed', `${command.job_id}.target-standby-one.json`, 'a-commands', JSON.stringify(routed), 'application/json');
  drive.put('result', `${command.job_id}.json`, 'a-results', JSON.stringify({ schema: 'drive-worker-result-v1',
    job_id: command.job_id, command_file_id: 'routed', status: 'DONE' }), 'application/json');
  const status = await service.getStatus(p, { job_id: command.job_id });
  assert.equal(status.publication_linkage, 'verified_routed_copy');
  assert.equal(JSON.stringify(status).includes('never-display'), false);
  // Original command can have been moved or removed: its immutable publication proof suffices.
  drive.files.delete(publication.command_file_id);
  assert.equal((await service.getStatus(p, { job_id: command.job_id })).publication_linkage, 'verified_routed_copy');
  const variants = [ { ...routed, command: 'tampered' }, { ...routed, origin_command_file_id: 'wrong' },
    { ...routed, origin_command_created_at: '2026-01-02T00:00:00.000Z' }, { ...routed, target_server: 'AUTO' },
    { ...routed, extra: 'not-allowed' }, { ...routed, job_id: 'different' } ];
  for (const body of variants) {
    drive.put('routed', `${command.job_id}.target-standby-one.json`, 'a-commands', JSON.stringify(body), 'application/json');
    await assert.rejects(service.getStatus(p, { job_id: command.job_id }), code('RESULT_INVALID'));
  }
  drive.put('routed', `${command.job_id}.target-standby-one.json`, 'b-commands', JSON.stringify(routed), 'application/json');
  await assert.rejects(service.getStatus(p, { job_id: command.job_id }), code('RESULT_INVALID'));
});

test('pinned-target publication cannot be converted into a routed copy and origin input is forbidden', async () => {
  const { service, drive, p } = setup(); const input = { ...command, target_server: 'Galaxy-S25' };
  assert.throws(() => normalizeCommand({ ...input, origin_command_file_id: 'forged' }, 'direct'), code('INVALID_COMMAND'));
  const publication = await service.submitDirect(p, input);
  drive.put('routed', `${command.job_id}.target-other.json`, 'a-commands', JSON.stringify({
    ...normalizeCommand(input, 'direct').body, target_server: 'other', origin_command_file_id: publication.command_file_id,
    origin_command_created_at: '2026-01-01T00:00:00.000Z' }), 'application/json');
  drive.put('result', `${command.job_id}.json`, 'a-results', JSON.stringify({ schema: 'drive-worker-result-v1',
    job_id: command.job_id, command_file_id: 'routed', status: 'DONE' }), 'application/json');
  await assert.rejects(service.getStatus(p, { job_id: command.job_id }), code('RESULT_INVALID'));
});

test('cursor is invalid after a provider revision even if sanitized text is identical', async () => {
  const { service, drive, p } = setup();
  drive.put('r', `${command.job_id}.json`, 'a-results', JSON.stringify({ schema: 'drive-worker-result-v1',
    job_id: command.job_id, status: 'DONE', stdout_file_id: 'log' }), 'application/json');
  drive.put('log', `${command.job_id}.stdout.txt`, 'a-results', '한글🙂'.repeat(100));
  drive.files.get('log')!.meta.version = '1';
  const first = await service.getResult(p, { job_id: command.job_id, stream: 'stdout', limit: 256 });
  assert.ok(first.next_cursor); assert.equal(String(first.text).includes('\ufffd'), false);
  drive.files.get('log')!.meta.version = '2';
  await assert.rejects(service.getResult(p, { job_id: command.job_id, stream: 'stdout', cursor: first.next_cursor }), code('CURSOR_INVALID'));
});

test('an unreadable or missing publication file is never recreated after confirmation', async () => {
  const { service, drive, p } = setup();
  const first = await service.publishManual(p, command); drive.files.delete(first.command_file_id);
  const second = await service.publishManual(p, command);
  assert.equal(first.command_file_id, second.command_file_id); assert.equal(drive.writes.length, 1);
});

test('oversized log is rejected before reading when metadata declares its size', async () => {
  const { service, drive, p } = setup();
  drive.put('r', `${command.job_id}.json`, 'a-results', JSON.stringify({ schema: 'drive-worker-result-v1',
    job_id: command.job_id, status: 'DONE', stdout_file_id: 'log' }), 'application/json');
  drive.put('log', `${command.job_id}.stdout.txt`, 'a-results', 'short');
  drive.files.get('log')!.meta.size = String(9 * 1024 * 1024);
  await assert.rejects(service.getResult(p, { job_id: command.job_id, stream: 'stdout' }), code('LOG_TOO_LARGE'));
  assert.equal(drive.reads.includes('log'), false);
});

test('log pages omit repeated tails and error text; summary tails have UTF-8 byte limits', async () => {
  const { service, drive, p } = setup();
  drive.put('r', `${command.job_id}.json`, 'a-results', JSON.stringify({ schema: 'drive-worker-result-v1',
    job_id: command.job_id, status: 'DONE', stdout_file_id: 'log', stdout_tail: '한'.repeat(20000),
    stderr_tail: '🙂'.repeat(20000), error: 'x'.repeat(20000), reason: 'x'.repeat(20000) }), 'application/json');
  drive.put('log', `${command.job_id}.stdout.txt`, 'a-results', 'line\n'.repeat(100));
  const summary = await service.getStatus(p, { job_id: command.job_id });
  assert.ok(Buffer.byteLength(String(summary.stdout_tail)) <= 16384);
  assert.ok(Buffer.byteLength(String(summary.stderr_tail)) <= 16384);
  const page = await service.getResult(p, { job_id: command.job_id, stream: 'stdout', limit: 256 });
  assert.equal('stdout_tail' in page, false); assert.equal('stderr_tail' in page, false);
  assert.equal('error' in page, false); assert.equal('reason' in page, false);
  assert.ok(Buffer.byteLength(String(page.text)) <= 256);
});
