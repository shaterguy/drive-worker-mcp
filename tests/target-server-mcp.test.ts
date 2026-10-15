import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createAuthenticatedMcpHandler } from '../src/mcp.ts';
import { DriveWorkerService } from '../src/service.ts';
import { FakeDrive, FakeStore } from './fakes.ts';
import type { Principal, ToolScope } from '../src/contracts.ts';

test('SDK keeps strict input schema and normalizes target_server on both publication routes', async () => {
  const store = new FakeStore(), drive = new FakeDrive();
  store.bindings.set('a', { accountId: 'a', manualFolderId: 'manual', commandsFolderId: 'commands', resultsFolderId: 'results' });
  for (const id of ['manual', 'commands', 'results']) drive.folder(id);
  const principal: Principal = { accountId: 'a', clientId: 'fixture', grantId: 'fixture',
    scopes: new Set<ToolScope>(['manual:publish', 'jobs:submit', 'jobs:read']) };
  const service = new DriveWorkerService({ store, driveForAccount: async () => drive,
    cursorKey: new Uint8Array(32).fill(8), assertActiveGrant: async () => {} });
  const handler = createAuthenticatedMcpHandler(service, principal);
  const client = new Client({ name: 'target-contract-tests', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  const transport = new StreamableHTTPClientTransport(new URL('https://fixture.invalid/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init))
  });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    for (const name of ['publish_manual_command', 'submit_direct_command']) {
      const schema = listed.tools.find(tool => tool.name === name)!.inputSchema;
      assert.equal(schema.additionalProperties, false);
      const targetSchema = schema.properties?.target_server, commandSchema = schema.properties?.command;
      assert.ok(targetSchema && typeof targetSchema === 'object' && !Array.isArray(targetSchema));
      assert.ok(commandSchema && typeof commandSchema === 'object' && !Array.isArray(commandSchema));
      assert.equal(targetSchema.type, 'string');
      assert.equal(targetSchema.maxLength, 128);
      assert.equal(commandSchema.type, 'string');
      const args = { job_id: 'MANUAL-SDK-' + name, command: 'printf harmless', cwd: '/tmp', timeout_ms: 1000 };
      const call = async (arguments_: Record<string, unknown>) => {
        const result = await client.callTool({ name, arguments: arguments_ });
        return { result, text: JSON.stringify(result) };
      };
      const first = await call({ ...args, target_server: 'Tablet' });
      assert.notEqual(first.result.isError, true);
      assert.ok(first.text.includes('UNSUPPORTED_TARGET_OMITTED'));
      const retry = await call({ ...args, target_server: 'AUTO' });
      assert.notEqual(retry.result.isError, true); assert.ok(retry.text.includes('UNSUPPORTED_TARGET_OMITTED'));
      const omitted = await call(args);
      assert.notEqual(omitted.result.isError, true); assert.equal(omitted.text.includes('input_corrections'), false);
      const empty = await call({ ...args, target_server: '' });
      assert.notEqual(empty.result.isError, true); assert.equal(empty.text.includes('input_corrections'), false);
      for (const target_server of [null, 42, 'a'.repeat(129), '한'.repeat(43), 'bad\0value'])
        assert.equal((await call({ ...args, target_server })).result.isError, true);
      for (const target_server of ['Galaxy-S25', 'Galaxy-Tab-S11-Ultra']) {
        const pinned = await call({ ...args, job_id: args.job_id + '-' + target_server, target_server });
        assert.notEqual(pinned.result.isError, true);
        assert.equal(pinned.text.includes('input_corrections'), false);
      }
      assert.equal((await call({ ...args, unexpected: true })).result.isError, true);
    }
    assert.deepEqual(drive.writes, ['manual', 'manual', 'manual', 'commands', 'commands', 'commands']);
    for (const publication of store.publications.values()) {
      const body = JSON.parse(Buffer.from(drive.files.get(publication.fileId)!.bytes).toString());
      assert.equal(body.schema, 'drive-worker-command-v1');
      if (!publication.jobId.includes('Galaxy-')) assert.equal(Object.hasOwn(body, 'target_server'), false);
    }
  } finally { await client.close(); await handler.close(); }
});
