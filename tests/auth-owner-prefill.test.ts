import test from 'node:test';
import assert from 'node:assert/strict';
import { GOOGLE_ISSUER, loadAuthConfig, parseOwnerFolderPrefill } from '../src/auth/config.ts';
import { initialFolderInputs } from '../src/auth/owner-prefill.ts';

const owner = Object.freeze({issuer:GOOGLE_ISSUER,sub:'synthetic-owner-sub',
  manualFolderId:'fixture-manual',commandsFolderId:'fixture-commands',resultsFolderId:'fixture-results'});
const identity = {issuer:GOOGLE_ISSUER,sub:owner.sub};

test('private prefill is optional, atomic, frozen and independent of required auth settings', () => {
  assert.equal(parseOwnerFolderPrefill(undefined),undefined);
  const parsed = parseOwnerFolderPrefill(JSON.stringify(owner));
  assert.deepEqual(parsed,owner);
  assert.equal(Object.isFrozen(parsed),true);
  const env = {DWMCP_PUBLIC_ORIGIN:'https://verified.example.test',
    DATABASE_URL:'postgresql://fixture:fixture@db.example.test/db?sslmode=require',
    BETTER_AUTH_SECRET:'fixture-only-secret-never-use-in-production',
    GOOGLE_CLIENT_ID:'fixture-client',GOOGLE_CLIENT_SECRET:'fixture-secret'};
  assert.equal(Object.hasOwn(loadAuthConfig(env),'ownerPrefill'),false);
  assert.deepEqual(loadAuthConfig({...env,DWMCP_OWNER_PREFILL_JSON:JSON.stringify(owner)}).ownerPrefill,owner);
});

test('malformed or partial private prefill fails closed without echoing values', () => {
  const malformed = ['', 'not-json', 'null', '[]', '{}', ' '.repeat(4097),
    JSON.stringify({...owner,issuer:'accounts.google.com'}),
    JSON.stringify({...owner,sub:''}), JSON.stringify({...owner,sub:'bad subject'}),
    JSON.stringify({...owner,sub:'x'.repeat(256)}),
    JSON.stringify({...owner,email:'never-match-by-email@example.test'}),
    JSON.stringify({...owner,commandsFolderId:owner.manualFolderId}),
    JSON.stringify({...owner,manualFolderId:'<private-marker>'}),
    JSON.stringify({...owner,resultsFolderId:undefined})];
  for (const value of malformed) assert.throws(() => parseOwnerFolderPrefill(value),{message:'OWNER_PREFILL_CONFIGURATION_INVALID'});
});

test('only the exact verified issuer and subject receive editable initial values', () => {
  const html = initialFolderInputs(owner,identity,false);
  for (const id of [owner.manualFolderId,owner.commandsFolderId,owner.resultsFolderId]) assert.ok(html.includes(`value="${id}"`));
  assert.match(html,/name="stateFolderId" value=""/);
  assert.doesNotMatch(html,/readonly|disabled|type="hidden"|synthetic-owner-sub/);
  for (const other of [{issuer:GOOGLE_ISSUER,sub:'different-sub'},{issuer:'https://other.example.test',sub:owner.sub}]) {
    const blank = initialFolderInputs(owner,other,false);
    assert.equal((blank.match(/value=""/g) ?? []).length,4);
    for (const id of [owner.manualFolderId,owner.commandsFolderId,owner.resultsFolderId]) assert.ok(!blank.includes(id));
  }
  assert.equal((initialFolderInputs(undefined,identity,false).match(/value=""/g) ?? []).length,4);
});

test('saved bindings win and presentation escapes values defensively', () => {
  assert.equal(initialFolderInputs(owner,identity,true),'');
  const html = initialFolderInputs({...owner,manualFolderId:'"<>&\''},identity,false);
  assert.ok(html.includes('value="&quot;&lt;&gt;&amp;&#39;"'));
  assert.ok(!html.includes('value=""<'));
});
