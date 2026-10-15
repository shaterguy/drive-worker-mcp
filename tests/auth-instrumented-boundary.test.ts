import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { Pool } from 'pg';
import { betterAuth } from 'better-auth';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { createSchemaOptions } from '../scripts/schema-config.ts';
import { createDeployment } from '../src/auth/deployment.ts';
import { createRuntimeRouter } from '../src/auth/runtime.ts';
import { protectMcpRoute } from '../src/auth/protected-mcp.ts';
import { PostgresAuthAuthority, TENANT_CLAIM, GRANT_CLAIM, REFERENCE_CLAIM } from '../src/auth/authority.ts';
import { loadAuthConfig, GOOGLE_SCOPES } from '../src/auth/config.ts';
import type { DriveWorkerAuth } from '../src/auth/better-auth.ts';
import type { PrincipalRead } from '../src/auth/request-diagnostics.ts';

const origin='https://telemetry-fixture.invalid',issuer=`${origin}/api/auth`,resource=`${origin}/mcp`;
const env={DWMCP_PUBLIC_ORIGIN:origin,DATABASE_URL:'postgresql://fixture:fixture@db.invalid/db?sslmode=require',
  BETTER_AUTH_SECRET:'synthetic-server-secret-never-use-in-production',GOOGLE_CLIENT_ID:'fixture-client',GOOGLE_CLIENT_SECRET:'SYNTHETIC_CLIENT_SECRET'};
const config=loadAuthConfig(env),sentinel='SYNTHETIC_PRIVATE_SENTINEL';
const keys=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk={...keys.publicKey.export({format:'jwk'}),kid:'telemetry-fixture',alg:'RS256',use:'sig'};
function token(suffix:'a'|'b'='a',overrides:Record<string,unknown>={}) {
  const claims={iss:issuer,aud:resource,sub:`user-${suffix}`,client_id:`client-${suffix}`,azp:`client-${suffix}`,scope:'jobs:read',
    exp:Math.floor(Date.now()/1000)+300,iat:Math.floor(Date.now()/1000),sid:`session-${suffix}`,
    [TENANT_CLAIM]:`tenant-${suffix}`,[GRANT_CLAIM]:`grant-${suffix}`,[REFERENCE_CLAIM]:`session-${suffix}`,...overrides};
  const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const input=`${encode({alg:'RS256',kid:'telemetry-fixture',typ:'at+jwt'})}.${encode(claims)}`;
  return `${input}.${sign('RSA-SHA256',Buffer.from(input),keys.privateKey).toString('base64url')}`;
}
function mcpRequest(bearer=token(),name='get_job_status',suffix='') {
  return new Request(`${resource}${suffix}`,{method:'POST',headers:{'content-type':'application/json',
    ...(bearer?{authorization:`Bearer ${bearer}`} : {}),'x-request-id':sentinel,cookie:`private=${sentinel}`},
  body:JSON.stringify({jsonrpc:'2.0',id:sentinel,method:'tools/call',params:{name,arguments:{job_id:sentinel}}})});
}
type TokenMode='success'|'failure'|'unauthorized'|'forbidden'|'redirect';
function fixture(options:{failure?:PrincipalRead;failOnlyB?:boolean;throwSink?:boolean;throwSnapshot?:boolean}={}) {
  const lines:string[]=[];let queries=0,executions=0,mode:TokenMode='success';
  const authOptions=createSchemaOptions(memoryAdapter({}));
  const tokenAuth=betterAuth({...authOptions,baseURL:origin,plugins:[{id:'telemetry-token-fixture',endpoints:{
    syntheticToken:createAuthEndpoint('/oauth2/token',{method:'POST',metadata:{allowedMediaTypes:['application/x-www-form-urlencoded']}},async()=>{
      if(mode==='failure')throw new Error(sentinel,{cause:{password:sentinel}});
      if(mode==='unauthorized')throw new APIError('UNAUTHORIZED',{error:'invalid_token'},{'WWW-Authenticate':'Bearer error="invalid_token"'});
      if(mode==='forbidden')throw new APIError('FORBIDDEN',{error:'insufficient_scope'},{'WWW-Authenticate':'Bearer error="insufficient_scope", scope="jobs:read"'});
      if(mode==='redirect'){
        const headers=new Headers({Location:`${origin}/connect`});headers.append('set-cookie','a=synthetic; HttpOnly');headers.append('set-cookie','b=synthetic; HttpOnly');
        throw new APIError('FOUND',undefined,headers);
      }
      return new Response(`synthetic-token-body-${sentinel}`,{headers:{'content-type':'text/plain'}});
    }),
  }}]});
  const query=async(sql:string,values?:readonly unknown[])=>{
    queries++;await nextTurn();
    const b=values?.some(value=>['tenant-b','account-b','user-b','grant-b','session-b'].includes(String(value)))??false;
    const suffix=b?'b':'a';
    const read:PrincipalRead=sql.includes('JOIN "account"')?'tenant':sql.includes('AS has_refresh')?'google_ready'
      :sql.includes('FROM dw_mcp_grants')?'grant':sql.includes('FROM "oauthConsent"')?'consent':'session';
    if(options.failure===read && (!options.failOnlyB || b))throw new Error(`private DB error ${sentinel}`,{cause:{sql,values,password:sentinel}});
    if(read==='tenant')return {rows:[{id:`tenant-${suffix}`,better_auth_user_id:`user-${suffix}`,better_auth_account_id:`account-${suffix}`,google_sub:`google-${suffix}`}]};
    if(read==='google_ready')return {rows:[{has_refresh:true,scope:GOOGLE_SCOPES.join(',')}]};
    if(read==='grant')return {rows:[{id:`grant-${suffix}`}]};
    if(read==='consent')return {rows:[{scopes:['jobs:read'],resources:[resource]}]};
    assert.ok(sql.includes('FROM "session"'));return {rows:[{id:`session-${suffix}`}]};
  };
  const authority=new PostgresAuthAuthority({query} as unknown as Pool,resource,issuer);
  const verifier={options:{},$context:Promise.resolve({baseURL:issuer,internalAdapter:{reserveVerificationValue:async()=>true}})} as unknown as DriveWorkerAuth;
  const mcp=protectMcpRoute(verifier,config,authority,async(_request,principal)=>{
    executions++;
    // The ordinary per-tool guard is still called, without the pre-handler diagnostic label.
    await authority.assertActiveGrant(principal);
    return Response.json({account:principal.accountId,isError:true,fixture:'HTTP success does not claim tool success'});
  });
  const router=createRuntimeRouter(config,{auth:tokenAuth,ui:async()=>new Response('synthetic-ui'),mcp});
  const deployment=createDeployment({environment:()=>env,diagnostics:{sink:line=>{
    lines.push(line);if(options.throwSink)throw new Error(sentinel);
  }},load:async()=>({fetch:router,checkDatabase:async()=>{},poolCounts:()=>{
    if(options.throwSnapshot)throw new Error(sentinel);return {total:3,idle:1,waiting:2};
  }})});
  return {deployment,lines,counts:()=>({queries,executions}),setTokenMode:(value:TokenMode)=>{mode=value;}};
}
function records(lines:string[]) {
  for(const line of lines){
    assert.ok(Buffer.byteLength(line)<1024);
    for(const privateText of [sentinel,'tenant-a','tenant-b','user-a','user-b','google-a','google-b','client-a','grant-a','session-a',env.DATABASE_URL,env.BETTER_AUTH_SECRET,env.GOOGLE_CLIENT_SECRET])assert.ok(!line.includes(privateText),'telemetry leaked synthetic private data');
  }
  return lines.map(line=>JSON.parse(line) as Record<string,unknown>);
}

test('instrumented deployment/runtime/maintained auth boundaries preserve behavior and isolate concurrent traces',async t=>{
  t.mock.method(globalThis,'fetch',async(input:RequestInfo|URL)=>{
    assert.equal(input instanceof Request?input.url:String(input),`${issuer}/jwks`,'no real network permitted');return Response.json({keys:[jwk]});
  });
  const unexpected:unknown[][]=[];
  for(const method of ['error','warn','log'] as const)t.mock.method(console,method,(...args:unknown[])=>{unexpected.push(args);});
  await t.test('missing token and insufficient scope retain exact maintained challenge statuses',async()=>{
    const f=fixture();
    const missing=await f.deployment.fetch(mcpRequest(''));
    assert.equal(missing.status,401);assert.match(missing.headers.get('www-authenticate')??'',/resource_metadata=/);
    // Missing and malformed authorization are distinct maintained error paths.
    const malformedRequest=mcpRequest('');malformedRequest.headers.set('authorization','Bearer');
    const malformed=await f.deployment.fetch(malformedRequest);
    assert.equal(malformed.status,401);assert.match(malformed.headers.get('www-authenticate')??'',/^DPoP error="invalid_token"/);
    const scope=await f.deployment.fetch(mcpRequest(token(),'publish_manual_command'));
    assert.equal(scope.status,403);assert.match(scope.headers.get('www-authenticate')??'',/insufficient_scope/);
    assert.equal(f.counts().executions,0);
    const r=records(f.lines);assert.equal(r.length,3);assert.equal(r[0]!.phase,'token_verification');assert.equal(r[1]!.phase,'token_verification');assert.equal(r[2]!.phase,'scope_preflight');
    assert.ok(r.every(value=>!Object.hasOwn(value,'principal_read')));
  });
  await t.test('each failed initial principal read is labeled once and preserves sanitized503',async()=>{
    for(const [index,read] of (['tenant','google_ready','grant','consent','session'] as const).entries()){
      const f=fixture({failure:read});const response=await f.deployment.fetch(mcpRequest());
      assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'AUTH_UNAVAILABLE'});
      assert.deepEqual(f.counts(),{queries:index+1,executions:0});
      const r=records(f.lines);assert.equal(r.length,1);assert.equal(r[0]!.phase,'principal');assert.equal(r[0]!.principal_read,read);assert.equal(r[0]!.http_status,503);
    }
  });
  await t.test('claim rejection before a read has no principal-read label or DB use',async()=>{
    const f=fixture();const response=await f.deployment.fetch(mcpRequest(token('a',{[TENANT_CLAIM]:''})));
    assert.equal(response.status,401);assert.deepEqual(f.counts(),{queries:0,executions:0});
    const r=records(f.lines);assert.equal(r.length,1);assert.equal(r[0]!.phase,'principal');assert.equal(Object.hasOwn(r[0]!,'principal_read'),false);
  });
  await t.test('normal result and every-tool grant recheck remain intact without success labels',async()=>{
    const f=fixture();const response=await f.deployment.fetch(mcpRequest(token(),'get_job_status',`?private=${sentinel}`));
    assert.equal(response.status,200);assert.equal((await response.json()).isError,true);assert.deepEqual(f.counts(),{queries:10,executions:1});
    const r=records(f.lines);assert.equal(r.length,1);assert.equal(r[0]!.phase,'sdk_dispatch');assert.equal(r[0]!.outcome,'http_2xx');assert.equal(Object.hasOwn(r[0]!,'principal_read'),false);
  });
  await t.test('13 mixed concurrent requests plus token requests keep request-local phases and identities',async()=>{
    const f=fixture({failure:'grant',failOnlyB:true});
    const pending=Array.from({length:13},(_,i)=>f.deployment.fetch(mcpRequest(token(i%2?'b':'a'))));
    const tokenRequest=new Request(`${issuer}/oauth2/token?private=${sentinel}`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:`client_assertion=${sentinel}`});
    const [responses,tokenResponse]=await Promise.all([Promise.all(pending),f.deployment.fetch(tokenRequest)]);
    for(let i=0;i<responses.length;i++){
      assert.equal(responses[i]!.status,i%2?503:200);
      if(i%2===0)assert.equal((await responses[i]!.json()).account,'tenant-a');
    }
    assert.equal(tokenResponse.status,200);assert.equal(f.counts().executions,7);
    const r=records(f.lines);assert.equal(r.length,14);
    assert.equal(r.filter(value=>value.route==='mcp'&&value.phase==='sdk_dispatch').length,7);
    assert.equal(r.filter(value=>value.route==='mcp'&&value.phase==='principal'&&value.principal_read==='grant').length,6);
    assert.equal(r.filter(value=>value.route==='oauth_token'&&value.phase==='oauth_token').length,1);
  });
  await t.test('maintained token endpoint preserves success, error, challenges, redirects and multiple cookies',async()=>{
    const f=fixture();
    for(const [mode,status] of [['success',200],['failure',503],['unauthorized',401],['forbidden',403],['redirect',302]] as const){
      f.setTokenMode(mode);
      const response=await f.deployment.fetch(new Request(`${issuer}/oauth2/token`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:`client_assertion=${sentinel}`}));
      assert.equal(response.status,status);
      if(mode==='success')assert.equal(await response.text(),`synthetic-token-body-${sentinel}`);
      if(mode==='failure')assert.deepEqual(await response.json(),{error:'AUTH_UNAVAILABLE'});
      if(mode==='unauthorized')assert.equal(response.headers.get('www-authenticate'),'Bearer error="invalid_token"');
      if(mode==='forbidden')assert.equal(response.headers.get('www-authenticate'),'Bearer error="insufficient_scope", scope="jobs:read"');
      if(mode==='redirect'){
        assert.equal(response.headers.get('location'),`${origin}/connect`);
        assert.deepEqual(response.headers.getSetCookie(),['a=synthetic; HttpOnly','b=synthetic; HttpOnly']);
      }
      assert.equal(response.headers.get('cache-control'),'no-store');
    }
    const r=records(f.lines);assert.equal(r.length,5);assert.ok(r.every(value=>value.route==='oauth_token'&&value.phase==='oauth_token'&&!Object.hasOwn(value,'principal_read')));
  });
  await t.test('method/origin/body rejects retain existing responses and boundary phase',async()=>{
    const f=fixture();
    const requests=[new Request(resource),new Request(resource,{method:'POST',headers:{origin:'https://foreign.invalid'}}),
      new Request(resource,{method:'POST',headers:{'content-length':'2000000'},body:'{}'})];
    for(const [i,request] of requests.entries())assert.equal((await f.deployment.fetch(request)).status,[405,400,413][i]);
    const r=records(f.lines);assert.equal(r.length,3);assert.ok(r.every(value=>value.phase==='boundary'));assert.deepEqual(f.counts(),{queries:0,executions:0});
  });
  await t.test('untraced paths emit nothing and throwing telemetry does not change success',async()=>{
    const f=fixture();
    for(const path of ['/health','/sign-in','/connect','/ui/connect','/api/auth/jwks','/unrelated'])await f.deployment.fetch(new Request(`${origin}${path}`));
    assert.equal(f.lines.length,0);
    const broken=fixture({throwSink:true,throwSnapshot:true});const response=await broken.deployment.fetch(mcpRequest());
    assert.equal(response.status,200);assert.deepEqual(broken.counts(),{queries:10,executions:1});
    const r=records(broken.lines);assert.equal(r.length,1);assert.equal(Object.hasOwn(r[0]!,'pool_total'),false);
  });
  await t.test('configuration and initialization failures emit one value-free existing503 record',async()=>{
    for(const configured of [false,true]){
      const lines:string[]=[];
      const deployment=createDeployment({environment:()=>configured?env:{},diagnostics:{sink:line=>{lines.push(line);}},load:async()=>{throw new Error(sentinel);}});
      const response=await deployment.fetch(mcpRequest());assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'AUTH_NOT_READY'});
      const r=records(lines);assert.equal(r.length,1);assert.equal(r[0]!.phase,configured?'runtime_init':'boundary');assert.equal(Object.hasOwn(r[0]!,'pool_total'),false);
    }
  });
  assert.equal(unexpected.length,0,'no raw fallback logger output permitted');
});
