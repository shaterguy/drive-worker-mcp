import test from 'node:test';
import assert from 'node:assert/strict';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { accountPrivacyHooks } from '../src/auth/account-privacy.ts';
import { createSchemaOptions } from '../scripts/schema-config.ts';

test('maintained account create/update hooks never retain provider ID tokens',async t=>{
  t.mock.method(globalThis,'fetch',async()=>{throw new Error('Unexpected network request in privacy fixture');});
  const memory: Record<string,Record<string,unknown>[]>={};
  const options=createSchemaOptions(memoryAdapter(memory));
  assert.equal(options.databaseHooks,accountPrivacyHooks);
  const auth=betterAuth({
    ...options,
    // Reuse the exact factory hooks/options, but omit provider plugins so this DB-only test cannot start discovery.
    plugins:[],
  });
  const {internalAdapter}=await auth.$context;
  // This exercises actual maintained hook persistence. Markers below are synthetic, not encryption evidence.
  const created=await internalAdapter.createOAuthUser(
    {name:'Fixture',email:'fixture@example.invalid',emailVerified:true},
    {providerId:'google',accountId:'fixture-google-sub',idToken:'fixture-id-token',
      accessToken:'fixture-encrypted-access',refreshToken:'fixture-encrypted-refresh',scope:'fixture-scope'});
  assert.ok(created.account);
  const accountId=created.account.id;
  const account=()=>memory.account?.find(row=>row.id===accountId);
  assert.equal(account()?.idToken,null);
  assert.equal(account()?.accountId,'fixture-google-sub');
  assert.equal(account()?.refreshToken,'fixture-encrypted-refresh');

  await internalAdapter.updateAccount(accountId,{idToken:'replacement-id-token',accessToken:'replacement-access'});
  assert.equal(account()?.idToken,null);
  assert.equal(account()?.accessToken,'replacement-access');
  assert.equal(account()?.refreshToken,'fixture-encrypted-refresh');

  // Refresh responses and updates with no providerId must still have the privacy hook applied.
  await internalAdapter.updateAccount(accountId,{accessToken:'refreshed-access'});
  assert.equal(account()?.idToken,null);
  assert.equal(account()?.refreshToken,'fixture-encrypted-refresh');
  assert.equal(account()?.userId,created.user.id);
});
