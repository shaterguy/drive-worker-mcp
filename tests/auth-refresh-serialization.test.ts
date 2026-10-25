import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { EventEmitter } from 'node:events';
import type { Pool } from 'pg';
import { createRefreshHandler } from '../src/auth/refresh.ts';

function request(token='synthetic-refresh',extra:Record<string,string>={}) {
  return new Request('https://refresh-fixture.invalid/api/auth/oauth2/token',{method:'POST',
    headers:{'content-type':'application/x-www-form-urlencoded',authorization:'Basic synthetic-client-proof'},
    body:new URLSearchParams({grant_type:'refresh_token',refresh_token:token,client_id:'synthetic-client',...extra})});
}
function database() {
  const locks=new Map<string,Promise<void>>(),queries:{sql:string;values?:unknown[]}[]=[];
  let connected=0,peak=0,released=0,failLock=false,failRollback=false;
  const clients:EventEmitter[]=[];
  const pool={connect:async()=>{
    connected++;peak=Math.max(peak,connected);let unlock:(()=>void)|undefined;
    const client=Object.assign(new EventEmitter(),{query:async(sql:string,values?:unknown[])=>{
      queries.push({sql,...(values?{values}:{})});
      if(sql.includes('pg_advisory_xact_lock')){
        if(failLock)throw new Error('synthetic-private-db-failure');
        const key=String(values?.[0]),previous=locks.get(key)??Promise.resolve();
        let resolve!:()=>void;const held=new Promise<void>(r=>{resolve=r;});locks.set(key,held);
        await previous;unlock=()=>{resolve();if(locks.get(key)===held)locks.delete(key);};
      }
      if(sql==='COMMIT'||sql==='ROLLBACK'){
        unlock?.();unlock=undefined;
        if(sql==='ROLLBACK'&&failRollback)throw new Error('synthetic-rollback-failure');
      }
      return {rows:[]};
    },release:()=>{unlock?.();connected--;released++;}});
    clients.push(client);return client;
  }} as unknown as Pick<Pool,'connect'>;
  return {pool,queries,clients,counts:()=>({connected,peak,released}),setFailure:(lock:boolean,rollback=false)=>{failLock=lock;failRollback=rollback;}};
}

test('different runtime instances serialize the same token before entering the maintained handler',async()=>{
  const db=database();let active=0,peak=0,invocations=0;
  const handler=async(r:Request)=>{
    active++;peak=Math.max(peak,active);invocations++;await nextTurn();
    assert.equal(r.headers.get('authorization'),'Basic synthetic-client-proof');
    assert.equal(new URLSearchParams(await r.text()).get('refresh_token'),'synthetic-refresh');
    active--;return Response.json({invocations});
  };
  const a=createRefreshHandler(db.pool,handler),b=createRefreshHandler(db.pool,handler);
  const responses=await Promise.all([a(request()),b(request())]);
  assert.deepEqual(responses.map(r=>r.status),[200,200]);assert.equal(peak,1);assert.equal(invocations,2);
  const keys=db.queries.filter(q=>q.sql.includes('pg_advisory_xact_lock')).map(q=>q.values?.[0]);
  assert.equal(keys.length,2);assert.equal(keys[0],keys[1]);
  assert.equal(JSON.stringify(db.queries).includes('synthetic-refresh'),false);
  assert.equal(db.counts().connected,0);
});

test('a runtime reserves at most one pool client while queued refreshes preserve independent scopes',async()=>{
  const db=database(),scopes:string[]=[];
  const handler=createRefreshHandler(db.pool,async r=>{
    scopes.push(new URLSearchParams(await r.text()).get('scope')??'');await nextTurn();return new Response('kept');
  });
  await Promise.all(Array.from({length:12},(_,i)=>handler(request(`synthetic-${i}`,{scope:`scope-${i}`}))));
  assert.equal(db.counts().peak,1);assert.equal(new Set(scopes).size,12);
  assert.equal(db.counts().connected,0);assert.equal(db.counts().released,12);
});

test('non-refresh grants pass through unchanged without taking a database lock',async()=>{
  const db=database();let called=0;
  const handler=createRefreshHandler(db.pool,async r=>{called++;return new Response(await r.text(),{status:201});});
  const r=request('synthetic',{grant_type:'authorization_code'}),body=await r.clone().text();
  const response=await handler(r);assert.equal(response.status,201);assert.equal(await response.text(),body);
  assert.equal(called,1);assert.equal(db.queries.length,0);
});

test('lock and handler failures release the transaction and leave the next refresh usable',async()=>{
  const db=database();let called=0,failHandler=false;
  const handler=createRefreshHandler(db.pool,async()=>{called++;if(failHandler)throw new Error('synthetic-handler-failure');return new Response('ok');});
  db.setFailure(true);await assert.rejects(handler(request()));assert.equal(called,0);
  db.setFailure(false);failHandler=true;await assert.rejects(handler(request()));
  failHandler=false;assert.equal((await handler(request())).status,200);
  assert.equal(db.counts().connected,0);
  assert.equal(db.queries.filter(q=>q.sql==='ROLLBACK').length,2);
});

test('refresh queue is bounded and overflow does not reach the auth handler',async()=>{
  const db=database();let finish!:()=>void,calls=0;
  const blocked=new Promise<void>(r=>{finish=r;});
  const handler=createRefreshHandler(db.pool,async()=>{calls++;await blocked;return new Response('ok');});
  const pending=Array.from({length:40},(_,i)=>handler(request(`synthetic-${i}`)).then(()=>true,()=>false));
  await nextTurn();finish();
  const outcomes=await Promise.all(pending);
  assert.ok(outcomes.includes(false));assert.equal(calls,outcomes.filter(Boolean).length);
  assert.equal(db.counts().peak,1);assert.equal(db.counts().connected,0);
});

test('provider-accepted whitespace and duplicate form keys cannot bypass the refresh lock',async()=>{
  const db=database();let called=0;
  const handler=createRefreshHandler(db.pool,async()=>{called++;return new Response('ok');});
  await handler(request('synthetic-refresh',{grant_type:' refresh_token '}));
  const body=new URLSearchParams({grant_type:'authorization_code',refresh_token:'ignored-synthetic'});
  body.append('grant_type','refresh_token');body.append('refresh_token','synthetic-refresh');
  await handler(new Request('https://refresh-fixture.invalid/api/auth/oauth2/token',{
    method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body}));
  const keys=db.queries.filter(q=>q.sql.includes('pg_advisory_xact_lock')).map(q=>q.values?.[0]);
  assert.equal(called,2);assert.equal(keys.length,2);assert.equal(keys[0],keys[1]);
});

test('a timed-out queue entry never enters auth and does not block later requests',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const db=database();let finish!:()=>void,calls=0;
  const blocked=new Promise<void>(r=>{finish=r;});
  const handler=createRefreshHandler(db.pool,async()=>{calls++;await blocked;return new Response('ok');});
  const first=handler(request());await nextTurn();
  const waiting=handler(request()).then(()=>false,()=>true);await nextTurn();
  t.mock.timers.tick(5_001);assert.equal(await waiting,true);assert.equal(calls,1);
  finish();await first;assert.equal((await handler(request())).status,200);
  assert.equal(calls,2);assert.equal(db.counts().connected,0);
});

test('a lost lock connection cannot return auth success or poison the refresh queue',async()=>{
  const db=database();let lose=true;
  const handler=createRefreshHandler(db.pool,async()=>{
    if(lose)db.clients.at(-1)!.emit('error',new Error('synthetic-private-connection-loss'));
    return new Response('ok');
  });
  await assert.rejects(handler(request()),{message:'AUTH_UNAVAILABLE'});
  lose=false;assert.equal((await handler(request())).status,200);
  assert.equal(db.counts().connected,0);
  assert.ok(db.queries.some(q=>q.sql==='SET LOCAL idle_in_transaction_session_timeout = 0'));
});

test('a request whose deadline expires while acquiring the lock never enters auth',async t=>{
  const db=database();let called=0,clockReads=0;
  t.mock.method(performance,'now',()=>++clockReads>=3?6_000:0);
  const handler=createRefreshHandler(db.pool,async()=>{called++;return new Response('unexpected');});
  await assert.rejects(handler(request()),{message:'AUTH_UNAVAILABLE'});
  assert.equal(called,0);assert.equal(db.counts().connected,0);
  assert.equal(db.queries.at(-1)?.sql,'ROLLBACK');
});
