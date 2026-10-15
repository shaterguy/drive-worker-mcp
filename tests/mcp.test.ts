import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createAuthenticatedMcpHandler } from '../src/mcp.ts';
import { DriveWorkerService } from '../src/service.ts';
import { FakeDrive, FakeStore } from './fakes.ts';
import type { Principal, ToolScope } from '../src/contracts.ts';

test('official SDK negotiates and serves exactly the four tools with fail-closed schema and grant gates', async () => {
  const store = new FakeStore(), drive = new FakeDrive();
  store.bindings.set('a', { accountId: 'a', manualFolderId: 'manual', commandsFolderId: 'commands', resultsFolderId: 'results' });
  for (const id of ['manual', 'commands', 'results']) drive.folder(id);
  let active = true;
  const principal: Principal = { accountId: 'a', clientId: 'fixture-client', grantId: 'fixture-grant',
    scopes: new Set<ToolScope>(['manual:publish', 'jobs:read']) };
  const service = new DriveWorkerService({ store, driveForAccount: async () => drive, cursorKey: new Uint8Array(32).fill(8),
    assertActiveGrant: async () => { if (!active) throw new Error('fixture-revoked'); } });
  const handler = createAuthenticatedMcpHandler(service, principal);
  const client = new Client({ name: 'contract-tests', version: '0.1.0' }, { versionNegotiation: { mode: 'auto' } });
  const transport = new StreamableHTTPClientTransport(new URL('https://fixture.invalid/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init))
  });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(t => t.name).sort(), ['get_job_result', 'get_job_status', 'publish_manual_command', 'submit_direct_command']);
    const args = { job_id: 'MANUAL-SDK', command: 'printf harmless', cwd: '/tmp', timeout_ms: 1000 };
    const manual = await client.callTool({ name: 'publish_manual_command', arguments: args });
    assert.notEqual(manual.isError, true); assert.deepEqual(drive.writes, ['manual']);
    const direct = await client.callTool({ name: 'submit_direct_command', arguments: args });
    assert.equal(direct.isError, true); assert.equal(JSON.stringify(direct).includes('INSUFFICIENT_SCOPE'), true);
    const invalid = await client.callTool({ name: 'publish_manual_command', arguments: { ...args, folder_id: 'evil' } });
    assert.equal(invalid.isError, true);
    active = false;
    const status = await client.callTool({ name: 'get_job_status', arguments: { job_id: args.job_id } });
    assert.equal(status.isError, true); assert.equal(JSON.stringify(status).includes('AUTH_REQUIRED'), true);
    assert.equal(drive.writes.length, 1);
  } finally { await client.close(); await handler.close(); }
});
