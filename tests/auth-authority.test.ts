import test from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { PostgresAuthAuthority, TENANT_CLAIM, GRANT_CLAIM, REFERENCE_CLAIM } from '../src/auth/authority.ts';
import { GOOGLE_SCOPES } from '../src/auth/config.ts';

const issuer='https://verified.example.test/api/auth', resource='https://verified.example.test/mcp';
function fixture() {
  const state={ revoked:false, consent:true, session:true, tenantUser:'user-a', scopes:['jobs:read'], resources:[resource], hasRefresh:true, googleScopes:GOOGLE_SCOPES.join(',') };
  const pool={query:async(sql:string)=>{
    if(sql.includes('AS has_refresh'))return {rows:[{has_refresh:state.hasRefresh,scope:state.googleScopes}]};
    if(sql.includes('JOIN "account"'))return {rows:[{id:'tenant-a',better_auth_user_id:state.tenantUser,better_auth_account_id:'account-a',google_sub:'google-a'}]};
    if(sql.includes('FROM dw_mcp_grants'))return {rows:state.revoked?[]:[{id:'grant-a',tenant_id:'tenant-a',client_id:'client-a',reference_id:'session-a',revoked_at:null}]};
    if(sql.includes('FROM "oauthConsent"'))return {rows:state.consent?[{scopes:state.scopes,resources:state.resources}]:[]};
    if(sql.includes('FROM "session"'))return {rows:state.session?[{id:'session-a'}]:[]};
    throw new Error('Unexpected fixture query');
  }} as unknown as Pool;
  const authority=new PostgresAuthAuthority(pool,resource,issuer);
  const claims={sub:'user-a',client_id:'client-a',azp:'client-a',aud:resource,scope:'jobs:read',exp:Math.floor(Date.now()/1000)+60,
    sid:'session-a',[TENANT_CLAIM]:'tenant-a',[GRANT_CLAIM]:'grant-a',[REFERENCE_CLAIM]:'session-a'};
  return {state,authority,claims};
}

test('valid resource or resource plus exact OIDC UserInfo audience accepted',async()=>{
  const {authority,claims}=fixture();
  assert.equal((await authority.principalFromVerifiedClaims(claims)).accountId,'tenant-a');
  assert.equal((await authority.principalFromVerifiedClaims({...claims,aud:[resource,`${issuer}/oauth2/userinfo`]})).accountId,'tenant-a');
  await assert.rejects(authority.principalFromVerifiedClaims({...claims,aud:[resource,'https://other.example.test/mcp']}));
  await assert.rejects(authority.principalFromVerifiedClaims({...claims,aud:`${issuer}/oauth2/userinfo`}));
});
test('every tool rechecks committed grant and live consent without a cache',async()=>{
  const {authority,claims,state}=fixture();const principal=await authority.principalFromVerifiedClaims(claims);
  state.revoked=true;await assert.rejects(authority.assertActiveGrant(principal));
  state.revoked=false;state.consent=false;await assert.rejects(authority.assertActiveGrant(principal));
  state.consent=true;state.scopes=[];await assert.rejects(authority.assertActiveGrant(principal));
});
test('subject tenant mismatch and client mismatch fail closed',async()=>{
  const {authority,claims,state}=fixture();state.tenantUser='user-b';await assert.rejects(authority.principalFromVerifiedClaims(claims));
  state.tenantUser='user-a';await assert.rejects(authority.principalFromVerifiedClaims({...claims,azp:'client-b'}));
});
test('expired or deleted reference session cannot be bypassed by a missing sid',async()=>{
  const {authority,claims,state}=fixture();state.session=false;
  await assert.rejects(authority.principalFromVerifiedClaims({...claims,sid:undefined}));
  state.session=true;await assert.rejects(authority.principalFromVerifiedClaims({...claims,sid:'different-session'}));
});
test('offline consent keeps existing tokens usable after browser session expiry or deletion',async()=>{
  const {authority,claims,state}=fixture();state.scopes.push('offline_access');state.session=false;
  assert.equal((await authority.principalFromVerifiedClaims({...claims,scope:'jobs:read offline_access'})).accountId,'tenant-a');
  const principal=await authority.principalFromVerifiedClaims({...claims,sid:undefined});
  await authority.assertActiveGrant(principal);
  await authority.principalFromVerifiedClaims({...claims,sid:null});
  state.scopes=['jobs:read'];await assert.rejects(authority.assertActiveGrant(principal));
});
test('offline consent never bypasses revocation, lost consent, Google readiness or sid lineage',async()=>{
  const {authority,claims,state}=fixture();state.scopes.push('offline_access');state.session=false;
  const principal=await authority.principalFromVerifiedClaims(claims);
  state.revoked=true;await assert.rejects(authority.assertActiveGrant(principal));state.revoked=false;
  state.consent=false;await assert.rejects(authority.assertActiveGrant(principal));state.consent=true;
  state.hasRefresh=false;await assert.rejects(authority.assertActiveGrant(principal));state.hasRefresh=true;
  await assert.rejects(authority.principalFromVerifiedClaims({...claims,sid:'different-session'}));
});
test('arbitrary principal and later scope mutation cannot acquire authority',async()=>{
  const {authority,claims}=fixture();
  await assert.rejects(authority.assertActiveGrant({accountId:'tenant-a',grantId:'grant-a',clientId:'client-a',scopes:new Set(['jobs:read'])}));
  const principal=await authority.principalFromVerifiedClaims(claims);
  (principal.scopes as Set<string>).add('jobs:submit');await assert.rejects(authority.assertActiveGrant(principal));
});
test('already expired token is rejected before database use',async()=>{
  const {authority,claims}=fixture();await assert.rejects(authority.principalFromVerifiedClaims({...claims,exp:0}));
});
test('existing usable app token stops when stored Google readiness is lost',async()=>{
  const {authority,claims,state}=fixture();const principal=await authority.principalFromVerifiedClaims(claims);
  state.hasRefresh=false;await assert.rejects(authority.assertActiveGrant(principal),{message:'GOOGLE_REAUTH_REQUIRED'});
  state.hasRefresh=true;state.googleScopes='https://www.googleapis.com/auth/drive.file';
  await assert.rejects(authority.assertActiveGrant(principal),{message:'GOOGLE_REAUTH_REQUIRED'});
});

function issuanceFixture() {
  const tenant={id:'tenant-a',better_auth_user_id:'user-a',better_auth_account_id:'account-a',google_sub:'google-a'};
  const state={hasRefresh:true,googleScopes:GOOGLE_SCOPES.join(','),inserts:0,rollbacks:0,session:true,consentScopes:['jobs:read']};
  const query=async(sql:string)=>{
    if(sql.includes('SELECT id, "accountId"'))return {rows:[{id:'account-a',accountId:'google-a'}]};
    if(sql.includes('INSERT INTO dw_mcp_tenants') || sql.includes('JOIN "account"'))return {rows:[tenant]};
    if(sql.includes('AS has_refresh'))return {rows:[{has_refresh:state.hasRefresh,scope:state.googleScopes}]};
    if(sql.includes('FROM "oauthConsent"'))return {rows:[{scopes:state.consentScopes,resources:[resource]}]};
    if(sql.includes('FROM "session"'))return {rows:state.session?[{id:'session-a'}]:[]};
    if(sql.includes('INSERT INTO dw_mcp_grants')){state.inserts++;return {rows:[]};}
    if(sql.includes('FROM dw_mcp_grants'))return {rows:[{id:'grant-a',tenant_id:'tenant-a',client_id:'client-a',reference_id:'session-a',revoked_at:null}]};
    if(sql==='ROLLBACK')state.rollbacks++;
    if(['BEGIN','COMMIT','ROLLBACK'].includes(sql))return {rows:[]};
    throw new Error('Unexpected issuance query');
  };
  const pool={query,connect:async()=>({query,release:()=>{}})} as unknown as Pool;
  return {state,authority:new PostgresAuthAuthority(pool,resource,issuer),input:{userId:'user-a',clientId:'client-a',referenceId:'session-a',sessionId:'session-a',grantType:'authorization_code',scopes:['jobs:read']}};
}
test('first missing refresh and existing-binding partial scopes block issuance before grant insert',async()=>{
  const {state,authority,input}=issuanceFixture();
  state.hasRefresh=false;await assert.rejects(authority.issueClaims(input),{message:'GOOGLE_REAUTH_REQUIRED'});
  state.hasRefresh=true;
  for(const scopes of ['https://www.googleapis.com/auth/drive.file','https://www.googleapis.com/auth/drive.readonly','']){
    state.googleScopes=scopes;await assert.rejects(authority.issueClaims(input),{message:'GOOGLE_REAUTH_REQUIRED'});
  }
  assert.equal(state.inserts,0);assert.equal(state.rollbacks,4);
});
test('offline refresh survives deleted original session while initial code and online refresh still require it',async()=>{
  const {state,authority,input}=issuanceFixture();state.session=false;state.consentScopes.push('offline_access');
  await authority.issueClaims({...input,grantType:'refresh_token',sessionId:undefined});
  assert.equal(state.inserts,0);
  await assert.rejects(authority.issueClaims(input));
  await assert.rejects(authority.issueClaims({...input,grantType:'refresh_token',sessionId:'wrong-session'}));
  state.consentScopes=['jobs:read'];
  await assert.rejects(authority.issueClaims({...input,grantType:'refresh_token',sessionId:undefined}));
});
test('same-account preserved stored refresh plus both scopes allows a new session grant',async()=>{
  const {state,authority,input}=issuanceFixture();
  // Tests app metadata policy only; actual Better Auth omitted-refresh persistence has a separate integration gate.
  state.googleScopes='https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.readonly';
  const claims=await authority.issueClaims(input);assert.equal(claims[TENANT_CLAIM],'tenant-a');assert.equal(state.inserts,1);
});
