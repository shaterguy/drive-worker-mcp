import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createAuthenticatedMcpHandler } from '../src/mcp.ts';
import { buildKbManualCommand } from '../src/kb-manual.ts';
import { DriveWorkerService } from '../src/service.ts';
import { FakeDrive, FakeStore } from './fakes.ts';
const signal = { issued_at: 1794870001, account_ref: 'a'.repeat(64) };
test('KB templates preserve business data and never interpolate user text into shell', () => {
  const context = { schema: 'kb-execution-context-v1', evidence: "quote ' ; arbitrary text" };
  const args = {job_id:'KB-MANUAL-TEST',request:{operation:'execute',...signal,orders:[{action:'buy',symbol:'005930',quantity:2,limit_krw:10000}],execution_context:context}};
  const command = buildKbManualCommand(args);
  assert.equal(command.command,'python3 -B /data/data/com.termux/files/home/.local/share/kbsec-bridge/kbsec_ai.py execute');
  assert.deepEqual(JSON.parse(command.stdin), { ...signal, orders: args.request.orders, execution_context: context });
  assert.equal(command.target_server, command.env.KBSEC_DRIVEWORKER_TARGET);
  assert.throws(()=>buildKbManualCommand({...args,command:'arbitrary'}));
  assert.throws(()=>buildKbManualCommand({...args,request:{operation:'read',tr:'IVU10140;id',fields:{}}}));
  assert.throws(()=>buildKbManualCommand({...args,request:{...args.request,execution_context:undefined}}));
  assert.throws(()=>buildKbManualCommand({...args,target_server:'AUTO'}));
  assert.throws(()=>buildKbManualCommand({...args,request:{operation:'publication-test',orders:[]}}));
  for(const request of [{operation:'signal-snapshot',...signal},{operation:'record-hold',...signal},{operation:'snapshot'},{operation:'read',tr:'IVU10140',fields:{shrt_cd:'005930'},offset:2},{operation:'broker-day',day:'20261117'},{operation:'order',order_id:'a'.repeat(24)}]) {
    assert.ok(buildKbManualCommand({job_id:'KB-MANUAL-TEST',request}).command.startsWith('python3 -B '));
  }
});
test('KB tool negotiates through MCP, publishes only manually, deduplicates and enforces grants', async () => {
  const store = new FakeStore(), drive = new FakeDrive();
  store.bindings.set('a',{accountId:'a',manualFolderId:'manual',commandsFolderId:'commands',resultsFolderId:'results'});
  for(const id of ['manual','commands','results'])drive.folder(id);
  let active=true;
  const principal={accountId:'a',clientId:'client',grantId:'grant',scopes:new Set<'manual:publish'>(['manual:publish'])};
  const service = new DriveWorkerService({store,driveForAccount:async()=>drive,cursorKey:new Uint8Array(32).fill(8),assertActiveGrant:async()=>{if(!active)throw Error('revoked');}});
  const handler=createAuthenticatedMcpHandler(service,principal);
  const client=new Client({name:'kb-test',version:'1.0.0'},{versionNegotiation:{mode:'auto'}});
  try{
    await client.connect(new StreamableHTTPClientTransport(new URL('https://fixture.invalid/mcp'),{fetch:(url,init)=>handler.fetch(new Request(url,init))}));
    const args={job_id:'KB-MANUAL-TEST',request:{operation:'publication-test'}};
    const call=()=>client.callTool({name:'publish_kb_manual_request',arguments:args});
    const replies=await Promise.all([call(),call()]);
    for(const r of replies)assert.notEqual(r.isError,true);
    assert.deepEqual(drive.writes,['manual']);
    const command=JSON.parse(new TextDecoder().decode(drive.files.get('reserved-1')!.bytes));
    assert.equal(command.command,"python3 -c 'print(\"KB_MANUAL_PUBLICATION_TEST_ONLY\")'");
    assert.equal(command.schema,'drive-worker-command-v1');
    const conflict=await client.callTool({name:'publish_kb_manual_request',arguments:{...args,request:{operation:'snapshot'}}});
    assert.equal(conflict.isError,true);
    active=false;
    assert.equal((await call()).isError,true);
    assert.equal(drive.writes.length,1);
  }finally{await client.close();await handler.close();}
});
