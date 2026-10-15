import test from 'node:test';
import assert from 'node:assert/strict';
import { DriveWorkerService, normalizeCommand } from '../src/service.ts';
import { canonical, digest } from '../src/output.ts';
import { FakeDrive, FakeStore } from './fakes.ts';
import type { Principal, Route, ToolScope } from '../src/contracts.ts';

const command = { job_id: 'MANUAL-TARGET', command: '  printf "hello\\n"\n', cwd: '/tmp/a b', timeout_ms: 1000,
  shell: '/bin/bash', env: { FIXTURE: '  value\\n  ' }, stdin: '  input\n' };
const allowed = ['Galaxy-S25', 'Galaxy-Tab-S11-Ultra'];
const fallback = ['', ' ', 'Tablet', 'Phone', 'AUTO', 'ACTIVE', 'STANDBY', 'random', 'Galaxy-S25 ', 'galaxy-s25', '한글'];
const notice = [{ field: 'target_server', code: 'UNSUPPORTED_TARGET_OMITTED', action: 'use_worker_automatic_selection' }];
function code(expected: string) { return (e: unknown) => !!e && typeof e === 'object' && 'code' in e && e.code === expected; }
function setup(route: Route) {
  const store = new FakeStore(), drive = new FakeDrive();
  store.bindings.set('a', { accountId: 'a', manualFolderId: 'manual', commandsFolderId: 'commands', resultsFolderId: 'results' });
  for (const id of ['manual', 'commands', 'results']) drive.folder(id);
  const p: Principal = { accountId: 'a', grantId: 'fixture', clientId: 'fixture',
    scopes: new Set<ToolScope>(['manual:publish', 'jobs:submit', 'jobs:read']) };
  const service = new DriveWorkerService({ store, driveForAccount: async () => drive,
    assertActiveGrant: async () => {}, cursorKey: new Uint8Array(32).fill(7) });
  return { store, drive, service, p, publish: (input: unknown) => service.publish(p, input, route) };
}

test('target fallback canonicalizes only target_server and preserves exact payload values', () => {
  for (const route of ['manual', 'direct'] as const) {
    const base = normalizeCommand(command, route);
    assert.deepEqual(base.body, { schema: 'drive-worker-command-v1', ...command });
    for (const target_server of fallback) {
      const value = normalizeCommand({ ...command, target_server }, route);
      assert.deepEqual(value.body, base.body);
      assert.equal(Object.hasOwn(value.body, 'target_server'), false);
      assert.equal(value.json, base.json); assert.equal(value.hash, base.hash);
      assert.equal(value.routingPayloadHash, base.routingPayloadHash); assert.equal(value.routingEligible, true);
      assert.deepEqual(value.inputCorrections, target_server === '' ? [] : notice);
      assert.equal(value.json.includes('input_corrections'), false);
    }
    assert.deepEqual(base.inputCorrections, []);
    for (const target_server of allowed) {
      const value = normalizeCommand({ ...command, target_server }, route);
      assert.equal(value.body.target_server, target_server); assert.equal(value.routingEligible, false);
      assert.notEqual(value.hash, base.hash); assert.equal(value.routingPayloadHash, base.routingPayloadHash);
      assert.deepEqual(value.inputCorrections, []);
    }
  }
});
test('non-string, NUL and oversized targets and other malformed fields remain rejected', () => {
  for (const route of ['manual', 'direct'] as const) {
    for (const target_server of [null, 1, true, [], {}, 'bad\0target', 'a'.repeat(129), '한'.repeat(43)])
      assert.throws(() => normalizeCommand({ ...command, target_server }, route), code('INVALID_COMMAND'));
    for (const change of [{ command: ' ' }, { cwd: 'relative' }, { timeout_ms: -1 }, { timeout_ms: '1000' },
      { shell: '' }, { stdin: 'bad\0' }, { env: { 'bad-key': 'x' } }, { schema: 'drive-worker-command-v1' }])
      assert.throws(() => normalizeCommand({ ...command, target_server: 'AUTO', ...change }, route), code('INVALID_COMMAND'));
    for (const target_server of ['a'.repeat(128), '한'.repeat(42) + 'ab'])
      assert.equal(normalizeCommand({ ...command, target_server }, route).hash, normalizeCommand(command, route).hash);
  }
});
for (const route of ['manual', 'direct'] as const) {
  test(route + ': equivalent concurrent inputs converge and corrections are request-local', async () => {
    const { store, drive, publish } = setup(route);
    const inputs = [command, ...fallback.map(target_server => ({ ...command, target_server }))];
    const replies = await Promise.all(inputs.map(input => publish(input)));
    assert.equal(new Set(replies.map(r => r.command_file_id)).size, 1);
    assert.equal(store.publications.size, 1); assert.equal(drive.writes.length, 1);
    assert.deepEqual(drive.writes, [route === 'manual' ? 'manual' : 'commands']);
    const bytes = Buffer.from(drive.files.get(replies[0]!.command_file_id)!.bytes).toString();
    assert.equal(bytes, normalizeCommand(command, route).json);
    for (let i = 0; i < inputs.length; i++) {
      const expected = i < 2 ? undefined : notice;
      assert.deepEqual(replies[i]!.input_corrections, expected);
      assert.deepEqual((await publish(inputs[i])).input_corrections, expected);
    }
    assert.equal(JSON.stringify([...store.publications.values()]).includes('input_corrections'), false);
    assert.equal(drive.writes.length, 1);
  });
  test(route + ': fresh fallback notices never echo input and empty/pinned inputs have no notices', async () => {
    for (const target_server of ['SECRET_TARGET_FIXTURE', '', ...allowed]) {
      const { drive, publish } = setup(route);
      const response = await publish({ ...command, target_server });
      assert.deepEqual(response.input_corrections, target_server === 'SECRET_TARGET_FIXTURE' ? notice : undefined);
      const responseText = JSON.stringify(response);
      for (const secret of ['SECRET_TARGET_FIXTURE', command.command, command.stdin, command.env.FIXTURE])
        assert.equal(responseText.includes(secret), false);
      const body = JSON.parse(Buffer.from(drive.files.get(response.command_file_id)!.bytes).toString());
      assert.equal(body.schema, 'drive-worker-command-v1');
      assert.equal(body.target_server, allowed.includes(target_server) ? target_server : undefined);
    }
  });
  test(route + ': changed real device, payload and route still conflict without writes', async () => {
    const { drive, service, p, publish } = setup(route);
    const pinned = { ...command, target_server: allowed[0] };
    await publish(pinned);
    for (const changed of [{ ...command, target_server: allowed[1] }, command, { ...pinned, command: 'changed' }])
      await assert.rejects(publish(changed), code('IDEMPOTENCY_CONFLICT'));
    await assert.rejects(service.publish(p, pinned, route === 'manual' ? 'direct' : 'manual'), code('IDEMPOTENCY_CONFLICT'));
    assert.equal(drive.writes.length, 1);
  });
  test(route + ': legacy unsupported-target publication is immutable and conflicts', async () => {
    const { store, drive, publish } = setup(route);
    const legacyJson = canonical({ schema: 'drive-worker-command-v1', ...command, target_server: 'Tablet' });
    const legacy = { accountId: 'a', jobId: command.job_id, route, contentHash: digest(legacyJson),
      routingPayloadHash: normalizeCommand(command, route).routingPayloadHash, routingEligible: false,
      createdTime: '2026-01-01T00:00:00.000Z', fileId: 'legacy', folderId: route === 'manual' ? 'manual' : 'commands',
      state: route === 'manual' ? 'PUBLISHED' as const : 'SUBMITTED' as const };
    store.publications.set(store.key('a', command.job_id), legacy);
    drive.put('legacy', command.job_id + '.json', legacy.folderId, legacyJson, 'application/json');
    const before = structuredClone(legacy);
    for (const input of [command, { ...command, target_server: 'Tablet' }, { ...command, target_server: '' }])
      await assert.rejects(publish(input), code('IDEMPOTENCY_CONFLICT'));
    assert.deepEqual(store.publications.get(store.key('a', command.job_id)), before);
    assert.equal(Buffer.from(drive.files.get('legacy')!.bytes).toString(), legacyJson);
    assert.equal(drive.writes.length, 0); assert.equal(drive.reserved, 0);
  });
}
