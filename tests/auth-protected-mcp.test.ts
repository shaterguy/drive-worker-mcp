import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import type { Pool } from 'pg';
import type { DriveWorkerAuth } from '../src/auth/better-auth.ts';
import { PostgresAuthAuthority, TENANT_CLAIM, GRANT_CLAIM, REFERENCE_CLAIM } from '../src/auth/authority.ts';
import { protectMcpRoute } from '../src/auth/protected-mcp.ts';
import { GOOGLE_SCOPES, type AuthConfig } from '../src/auth/config.ts';

test('actual maintained MCP authentication preserves 401/403 challenges through the app wrapper',async t=>{
  const origin='https://scope-fixture.invalid',issuer=`${origin}/api/auth`,resource=`${origin}/mcp`;
  const config: AuthConfig={origin,issuer,resource,googleCallback:`${issuer}/callback/google`,databaseUrl:'unused',secret:'fixture',googleClientId:'fixture',googleClientSecret:'fixture'};
  // Ephemeral test material only. The production signer/verifier remains Better Auth; nothing is persisted.
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const jwk={...publicKey.export({format:'jwk'}),kid:'scope-fixture',alg:'RS256',use:'sig'};
  t.mock.method(globalThis,'fetch',async(input:RequestInfo | URL)=>{
    const url=input instanceof Request?input.url:String(input);
    assert.equal(url,`${issuer}/jwks`,'test must never contact a real external service');
    return Response.json({keys:[jwk]});
  });
  let executions=0,queries=0;
  const query=async(sql:string)=>{
    queries++;
    if(sql.includes('JOIN "account"'))return {rows:[{id:'tenant-a',better_auth_user_id:'user-a',better_auth_account_id:'account-a',google_sub:'google-a'}]};
    if(sql.includes('AS has_refresh'))return {rows:[{has_refresh:true,scope:GOOGLE_SCOPES.join(',')}]};
    if(sql.includes('FROM dw_mcp_grants'))return {rows:[{id:'grant-a',tenant_id:'tenant-a',client_id:'client-a',reference_id:'session-a',revoked_at:null}]};
    if(sql.includes('FROM "oauthConsent"'))return {rows:[{scopes:['jobs:read'],resources:[resource]}]};
    if(sql.includes('FROM "session"'))return {rows:[{id:'session-a'}]};
    throw new Error('Unexpected fixture query');
  };
  const authority=new PostgresAuthAuthority({query} as unknown as Pool,resource,issuer);
  // Only the context portion consumed by real requireMcpAuth is stubbed; JWT verification is not mocked.
  const auth={options:{},$context:Promise.resolve({baseURL:issuer,internalAdapter:{reserveVerificationValue:async()=>true}})} as unknown as DriveWorkerAuth;
  const route=protectMcpRoute(auth,config,authority,async()=>{executions++;return Response.json({ok:true});});
  const claims={iss:issuer,aud:resource,sub:'user-a',client_id:'client-a',azp:'client-a',scope:'jobs:read',
    exp:Math.floor(Date.now()/1000)+120,iat:Math.floor(Date.now()/1000),sid:'session-a',
    [TENANT_CLAIM]:'tenant-a',[GRANT_CLAIM]:'grant-a',[REFERENCE_CLAIM]:'session-a'};
  const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');
  const signedInput=`${encode({alg:'RS256',kid:'scope-fixture',typ:'at+jwt'})}.${encode(claims)}`;
  const token=`${signedInput}.${sign('RSA-SHA256',Buffer.from(signedInput),privateKey).toString('base64url')}`;
  const call=(name:string,id=1)=>({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:{}}});
  const request=(body:unknown,bearer:string|undefined=token)=>new Request(resource,{method:'POST',
    headers:{'content-type':'application/json',...(bearer?{authorization:`Bearer ${bearer}`}:{})},body:JSON.stringify(body)});

  await t.test('missing and invalid tokens stop before app authority',async()=>{
    for(const bearer of ['',`${signedInput}.invalid-signature`]){
      const response=await route(request(call('get_job_status'),bearer));
      assert.equal(response.status,401);assert.match(response.headers.get('www-authenticate')??'',/resource_metadata=/);
    }
    assert.equal(queries,0);assert.equal(executions,0);
  });
  await t.test('single tool step-up is HTTP 403 with insufficient_scope, never 503',async()=>{
    const response=await route(request(call('publish_manual_command')));
    assert.equal(response.status,403);assert.match(response.headers.get('www-authenticate')??'',/error="insufficient_scope"/);
    assert.match(response.headers.get('www-authenticate')??'',/manual:publish/);assert.equal(executions,0);
  });
  await t.test('accepted batch format preflights every member before SDK execution',async()=>{
    const response=await route(request([call('get_job_status',1),call('submit_direct_command',2)]));
    assert.equal(response.status,403);assert.match(response.headers.get('www-authenticate')??'',/jobs:submit/);assert.equal(executions,0);
  });
  await t.test('granted read scope reaches the request-local executor',async()=>{
    const response=await route(request(call('get_job_result')));assert.equal(response.status,200);assert.equal(executions,1);
    assert.equal(response.headers.get('cache-control'),'no-store');
  });
});
