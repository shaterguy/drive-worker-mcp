import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { createOAuthOutcomeWriter, type OAuthOperation } from '../src/auth/oauth-outcome-counts.ts';

function poolFixture(query: (sql: string, values: unknown[]) => Promise<unknown>) {
  return {totalCount:1,idleCount:1,waitingCount:0,query:query as Pool['query']};
}

test('hourly counters coalesce atomically, bound cardinality and hide aged slots',async t=>{
  const db=new PGlite();
  try {
    const ddl=await readFile(new URL('../sql/oauth-outcome-counts.sql',import.meta.url),'utf8');
    await db.exec(ddl);await db.exec(ddl);
    const binds:unknown[][]=[];
    const write=createOAuthOutcomeWriter(poolFixture(async(sql,values)=>{
      binds.push(values);return db.query(sql,values);
    }));
    const hour=Math.floor(Date.now()/3_600_000);
    const clock=t.mock.method(Date,'now',()=>hour*3_600_000);
    await Promise.all([write('refresh',400),write('refresh',400)]);
    await write('refresh',200);await write('code',200);
    await write('code',403);await write('revoke',200);await write('revoke',503);
    await write('private-account' as OAuthOperation,400);await write('code',700);await write('revoke',301.1);
    const counts=()=>db.query<{operation:string;http_status:number;occurrences:number}>(
      'SELECT operation,http_status,occurrences FROM dw_mcp_oauth_recent_counts ORDER BY operation,http_status');
    assert.deepEqual((await counts()).rows,[
      {operation:'code',http_status:403,occurrences:1},{operation:'refresh',http_status:400,occurrences:2},
      {operation:'revoke',http_status:200,occurrences:1},{operation:'revoke',http_status:503,occurrences:1},
    ]);
    assert.deepEqual(binds,[[hour,'refresh',400],[hour,'refresh',400],[hour,'code',403],[hour,'revoke',200],[hour,'revoke',503]]);
    clock.mock.mockImplementation(()=> (hour - 720)*3_600_000);
    await write('code',401);await write('refresh',400);
    clock.mock.mockImplementation(()=>hour*3_600_000);
    assert.equal((await counts()).rows.length,4);
    await write('code',401);
    assert.equal((await counts()).rows.find(row=>row.operation==='code'&&row.http_status===401)?.occurrences,1);
    assert.equal((await counts()).rows.find(row=>row.operation==='refresh')?.occurrences,2);
    assert.equal((await db.query('SELECT * FROM dw_mcp_oauth_hourly_counts')).rows.length,5);
    await assert.rejects(db.query("INSERT INTO dw_mcp_oauth_hourly_counts(utc_hour,operation,http_status,occurrences) VALUES (0,'private-data',400,1)"));
  } finally { await db.close(); }
});

test('a busy, unavailable or delayed pool cannot hold up auth or create unbounded writers',async()=>{
  let calls=0;
  let settle: (()=>void) | undefined;
  const slow=new Promise<void>(resolve=>{settle=resolve;});
  const pool=poolFixture(async()=>{calls++;return slow;});
  const write=createOAuthOutcomeWriter(pool);
  pool.waitingCount=2;await write('revoke',200);assert.equal(calls,0);
  pool.waitingCount=0;pool.idleCount=0;pool.totalCount=2;await write('refresh',400);assert.equal(calls,0);
  pool.idleCount=1;
  const all=Promise.all(Array.from({length:32},()=>write('refresh',400))).then(()=>true);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    assert.equal(await Promise.race([all,new Promise(resolve=>{timeout=setTimeout(()=>resolve(false),1500);})]),true);
    assert.equal(calls,1);
  } finally { clearTimeout(timeout);settle?.(); }
  await createOAuthOutcomeWriter(poolFixture(async()=>{throw new Error('private-db-error');}))('revoke',200);
});
