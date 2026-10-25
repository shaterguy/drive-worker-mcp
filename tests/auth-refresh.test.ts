import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { createAuthOptions } from '../src/auth/better-auth.ts';
import { loadAuthConfig } from '../src/auth/config.ts';

const origin='https://refresh-fixture.invalid',resource=`${origin}/mcp`;
const config=loadAuthConfig({DWMCP_PUBLIC_ORIGIN:origin,
  DATABASE_URL:'postgresql://fixture:fixture@db.invalid/db?sslmode=require',
  BETTER_AUTH_SECRET:'synthetic-refresh-fixture-secret-never-use-in-production',
  GOOGLE_CLIENT_ID:'synthetic-google-client',GOOGLE_CLIENT_SECRET:'synthetic-google-secret'});
const initialToken='synthetic-initial-refresh-token',clientId='synthetic-public-client';
async function fixture() {
  const memory:Record<string,Record<string,unknown>[]>=Object.fromEntries([
    'user','session','account','verification','jwks','oauthAccessToken','oauthClient',
    'oauthClientAssertion','oauthClientResource','oauthConsent','oauthRefreshToken','oauthResource',
  ].map(name=>[name,[]]));
  const options=createAuthOptions(config,memoryAdapter(memory),{
    consentReference:async()=> 'synthetic-reference',isBindingMissing:async()=>false,
    issueClaims:async()=>({'urn:drive-worker-mcp:tenant':'synthetic-tenant',
      'urn:drive-worker-mcp:grant':'synthetic-grant','urn:drive-worker-mcp:reference':'synthetic-reference'}),
  });
  const auth=betterAuth({...options,plugins:options.plugins.filter(plugin=>plugin.id!=='generic-oauth')});
  const context=await auth.$context;
  const user=await context.adapter.create<{id:string}>({model:'user',data:{name:'Synthetic fixture',
    email:'fixture@example.invalid',emailVerified:true,createdAt:new Date(),updatedAt:new Date()}});
  const session=await context.adapter.create<{id:string}>({model:'session',data:{userId:user.id,
    token:'synthetic-session-token',expiresAt:new Date(Date.now()+86_400_000),createdAt:new Date(),updatedAt:new Date()}});
  await context.adapter.create({model:'oauthClient',data:{clientId,disabled:false,
    tokenEndpointAuthMethod:'none',requirePKCE:true,grantTypes:['authorization_code','refresh_token'],
    responseTypes:['code'],scopes:['jobs:read','offline_access'],redirectUris:[`${origin}/callback`],
    createdAt:new Date(),updatedAt:new Date()}});
  await context.adapter.create({model:'oauthResource',data:{identifier:resource,name:'Synthetic resource',
    allowedScopes:['jobs:read','offline_access'],disabled:false,createdAt:new Date(),updatedAt:new Date()}});
  await context.adapter.create({model:'oauthClientResource',data:{clientId,resourceId:resource,createdAt:new Date()}});
  await context.adapter.create({model:'oauthRefreshToken',data:{
    token:createHash('sha256').update(initialToken).digest('base64url'),clientId,userId:user.id,
    sessionId:session.id,referenceId:'synthetic-reference',scopes:['jobs:read','offline_access'],
    resources:[resource],expiresAt:new Date(Date.now()+86_400_000),createdAt:new Date(),
  }});
  const refresh=(token=initialToken,changes:Record<string,string>={})=>auth.handler(new Request(`${origin}/api/auth/oauth2/token`,{
    method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({grant_type:'refresh_token',client_id:clientId,refresh_token:token,resource,...changes}),
  }));
  return {auth,memory,refresh};
}

test('lost refresh response can be retried without replacing or invalidating its token pair',async t=>{
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('UNEXPECTED_FIXTURE_NETWORK');});
  const f=await fixture();
  const first=await f.refresh();assert.equal(first.status,200,await first.clone().text());
  const a=await first.json();
  const repeated=await f.refresh();assert.equal(repeated.status,200);
  const b=await repeated.json();
  assert.equal(b.refresh_token,a.refresh_token);assert.equal(b.access_token,a.access_token);
  assert.equal(f.memory.oauthRefreshToken!.length,2);
  const parent=f.memory.oauthRefreshToken![0]!;
  assert.equal(typeof parent.rotationReplayResponse,'string');
  assert.equal(String(parent.rotationReplayResponse).includes(a.refresh_token),false);
  const next=await f.refresh(a.refresh_token);assert.equal(next.status,200);
});

test('changed scopes and another client cannot obtain the cached response',async t=>{
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('UNEXPECTED_FIXTURE_NETWORK');});
  const f=await fixture(),first=await f.refresh();assert.equal(first.status,200);
  const a=await first.json();
  assert.equal((await f.refresh(initialToken,{scope:'jobs:read'})).status,400);
  assert.equal((await f.refresh(initialToken,{client_id:'different-synthetic-client'})).status,400);
  assert.equal((await f.refresh(initialToken,{resource:'https://other.invalid/mcp'})).status,400);
  assert.equal((await f.refresh(a.refresh_token)).status,200);
});

test('expired overlap and disconnected-token removal keep rejecting refresh replay',async t=>{
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('UNEXPECTED_FIXTURE_NETWORK');});
  const expired=await fixture();assert.equal((await expired.refresh()).status,200);
  expired.memory.oauthRefreshToken![0]!.rotationReplayExpiresAt=new Date(Date.now()-1000);
  assert.equal((await expired.refresh()).status,400);
  assert.equal(expired.memory.oauthRefreshToken!.length,0);
  const revoked=await fixture();assert.equal((await revoked.refresh()).status,200);
  revoked.memory.oauthRefreshToken!.splice(0);
  assert.equal((await revoked.refresh()).status,400);
});

test('the maintained revoke endpoint disables the newly issued refresh token',async t=>{
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('UNEXPECTED_FIXTURE_NETWORK');});
  const f=await fixture(),first=await f.refresh();assert.equal(first.status,200);
  const pair=await first.json();
  const revoked=await f.auth.handler(new Request(`${origin}/api/auth/oauth2/revoke`,{
    method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({client_id:clientId,token:pair.refresh_token,token_type_hint:'refresh_token'}),
  }));
  assert.equal(revoked.status,200);assert.equal((await f.refresh(pair.refresh_token)).status,400);
});
