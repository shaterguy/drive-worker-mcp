import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { GoogleDrive } from '../src/google-drive.ts';
import { createAuthenticatedMcpHandler } from '../src/mcp.ts';
import { DriveWorkerService } from '../src/service.ts';
import { FakeStore } from './fakes.ts';
import type { Principal, ToolScope } from '../src/contracts.ts';

test('the SDK preserves upstream correlation and read-only retry semantics on all four tool boundaries', async () => {
  const store = new FakeStore(), lines: string[] = [];
  store.bindings.set('fixture-account', { accountId: 'fixture-account', manualFolderId: 'manual', commandsFolderId: 'commands', resultsFolderId: 'results' });
  const options = { getAccessToken: async () => 'synthetic-token', diagnostics: { sink: (line: string) => lines.push(line) },
    fetch: async () => new Response('SYNTHETIC_PRIVATE_PROVIDER_BODY', { status: 403,
      headers: { 'x-request-id': 'SYNTHETIC_PROVIDER_ID', 'set-cookie': 'SYNTHETIC_COOKIE' } }) };
  const principal: Principal = { accountId: 'fixture-account', clientId: 'fixture-client', grantId: 'fixture-grant',
    scopes: new Set<ToolScope>(['manual:publish', 'jobs:submit', 'jobs:read']) };
  let grantChecks = 0;
  const service = new DriveWorkerService({ store, driveForAccount: async () => new GoogleDrive(options),
    cursorKey: new Uint8Array(32).fill(8), assertActiveGrant: async () => { grantChecks++; } });
  const handler = createAuthenticatedMcpHandler(service, principal);
  const client = new Client({ name: 'upstream-error-tests', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  const transport = new StreamableHTTPClientTransport(new URL('https://fixture.invalid/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init))
  });
  try {
    await client.connect(transport);
    for (const name of ['get_job_status', 'get_job_result', 'publish_manual_command', 'submit_direct_command']) {
      const publication = name === 'publish_manual_command' || name === 'submit_direct_command';
      const args = publication ? { job_id: 'MANUAL-SDK-ERROR', command: 'printf harmless', cwd: '/tmp', timeout_ms: 1000 }
        : { job_id: 'MANUAL-SDK-ERROR' };
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true);
      const content = result.content as Array<{ type: string; text?: string }>;
      const safe = JSON.parse(content.find(item => item.type === 'text')!.text!).error;
      assert.equal(safe.code, 'UPSTREAM_FORBIDDEN_UNKNOWN');
      assert.equal(safe.retryable, !publication);
      const log = JSON.parse(lines.at(-1)!);
      assert.equal(safe.correlation_id, log.correlation_id);
      if (publication) {
        assert.match(safe.action, /identical job_id, body and route/);
        assert.match(safe.action, /Do not create a new job/);
      } else assert.match(safe.action, /same read/);
      assert.equal(JSON.stringify([result, lines]).includes('SYNTHETIC_'), false);
    }
    assert.equal(grantChecks, 4); assert.equal(lines.length, 4); assert.equal(store.publications.size, 0);
  } finally { await client.close(); await handler.close(); }
});
