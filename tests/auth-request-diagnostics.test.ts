import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { beginRequestDiagnostics, observePrincipalRead, type DiagnosticPhase, type PrincipalRead } from '../src/auth/request-diagnostics.ts';

function fixture(path='/mcp') {
  const lines:string[]=[];let time=10;
  const trace=beginRequestDiagnostics(path,{now:()=>time,sink:line=>{lines.push(line);}});
  return {trace,lines,advance:(value:number)=>{time=value;}};
}
test('diagnostics are created only for the two exact route paths',()=>{
  for(const path of ['/health','/api/auth/jwks','/sign-in','/connect','/ui/connect','/api/auth/get-access-token','/mcp/','/mcp?private','/api/auth/oauth2/token/']){
    const f=fixture(path);assert.equal(f.trace,undefined);assert.equal(f.lines.length,0);
  }
  for(const [path,route] of [['/mcp','mcp'],['/api/auth/oauth2/token','oauth_token']] as const){
    const f=fixture(path);assert.ok(f.trace);f.trace.finish(200);assert.equal(JSON.parse(f.lines[0]!).route,route);
  }
});
test('closed projection emits only fixed fields, bounded numbers and one completion',()=>{
  const f=fixture();assert.ok(f.trace);
  f.trace.setPoolReader(()=>({total:3,idle:1,waiting:10,password:'SYNTHETIC_PRIVATE_VALUE'}));
  f.trace.markPhase('principal');f.trace.markPhase('SYNTHETIC_PRIVATE_VALUE' as DiagnosticPhase);
  f.trace.markPrincipalFailure('SYNTHETIC_PRIVATE_VALUE' as PrincipalRead);
  f.advance(15.6);f.trace.finish(503);f.trace.finish(200);f.trace.markPhase('sdk_dispatch');
  assert.equal(f.lines.length,1);
  assert.deepEqual(JSON.parse(f.lines[0]!),{event:'dwmcp_boundary_v1',route:'mcp',phase:'principal',outcome:'unavailable',
    http_status:503,duration_ms:6,pool_total:3,pool_idle:1,pool_waiting:10});
  assert.ok(Buffer.byteLength(f.lines[0]!)<1024);assert.ok(!f.lines[0]!.includes('PRIVATE'));
});
test('failure read labels capture pool counts at failure and success omits the label',async()=>{
  const f=fixture();assert.ok(f.trace);let waiting=9;
  f.trace.setPoolReader(()=>({total:3,idle:0,waiting}));
  assert.equal(await observePrincipalRead(f.trace,'tenant',async()=>7),7);
  const error=new Error('SYNTHETIC_PRIVATE_ERROR',{cause:{secret:'SYNTHETIC_PRIVATE_CAUSE'}});
  await assert.rejects(observePrincipalRead(f.trace,'consent',async()=>{throw error;}),value=>value===error);
  waiting=0;f.trace.markPrincipalFailure('session');f.trace.finish(503);
  const record=JSON.parse(f.lines[0]!);assert.equal(record.principal_read,'consent');assert.equal(record.pool_waiting,9);
  assert.ok(!f.lines[0]!.includes('PRIVATE'));
  const good=fixture();assert.ok(good.trace);await observePrincipalRead(good.trace,'session',async()=>{});good.trace.finish(200);
  assert.equal(Object.hasOwn(JSON.parse(good.lines[0]!),'principal_read'),false);
  await assert.rejects(observePrincipalRead(undefined,'tenant',async()=>{throw error;}),value=>value===error);
});
test('HTTP outcome classifications do not inspect or claim tool result success',()=>{
  for(const [status,outcome] of [[200,'http_2xx'],[204,'http_2xx'],[302,'http_3xx'],[400,'request_rejected'],
    [401,'auth_required'],[403,'forbidden'],[405,'request_rejected'],[413,'request_rejected'],[429,'request_rejected'],[503,'unavailable'],[101,'other_http']] as const){
    const f=fixture();assert.ok(f.trace);f.trace.finish(status);const record=JSON.parse(f.lines[0]!);
    assert.equal(record.outcome,outcome);assert.equal(record.http_status,status);
  }
});
test('nonfinite inputs, clocks and snapshots cannot enter the record',()=>{
  const f=fixture();assert.ok(f.trace);f.trace.setPoolReader(()=>({total:Infinity,idle:0,waiting:0}));
  f.advance(NaN);f.trace.finish(NaN);const record=JSON.parse(f.lines[0]!);
  assert.equal(record.http_status,503);assert.equal(record.duration_ms,0);assert.equal(Object.hasOwn(record,'pool_total'),false);
  const high=fixture();assert.ok(high.trace);high.trace.setPoolReader(()=>({total:999999,idle:-10,waiting:2.6}));high.advance(99999999);high.trace.finish(200);
  assert.deepEqual(JSON.parse(high.lines[0]!),{event:'dwmcp_boundary_v1',route:'mcp',phase:'boundary',outcome:'http_2xx',http_status:200,
    duration_ms:600000,pool_total:65535,pool_idle:0,pool_waiting:3});
});
test('throwing clock, snapshot and sync or async sinks cannot escape or duplicate logs',async()=>{
  const lines:string[]=[];
  const trace=beginRequestDiagnostics('/mcp',{now:()=>{throw new Error('PRIVATE_CLOCK');},sink:line=>{lines.push(line);throw new Error('PRIVATE_SINK');}});
  assert.ok(trace);trace.setPoolReader(()=>{throw new Error('PRIVATE_POOL');});
  assert.doesNotThrow(()=>{trace.markPrincipalFailure('tenant');trace.finish(503);trace.finish(503);});
  assert.equal(lines.length,1);assert.ok(!lines[0]!.includes('PRIVATE'));assert.equal(JSON.parse(lines[0]!).duration_ms,0);
  const asynchronous=beginRequestDiagnostics('/mcp',{sink:async()=>{throw new Error('PRIVATE_ASYNC_SINK');}});
  assert.ok(asynchronous);asynchronous.finish(200);await nextTurn();
});
