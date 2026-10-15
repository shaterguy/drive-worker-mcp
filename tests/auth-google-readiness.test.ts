import test from 'node:test';
import assert from 'node:assert/strict';
import { GOOGLE_SCOPES } from '../src/auth/config.ts';
import { hasRequiredDriveScopes, verifiedGoogleSubject } from '../src/auth/google-readiness.ts';

test('verified provider hook rejects either partial Drive grant and missing scope metadata',()=>{
  for(const scopes of [undefined,[],['https://www.googleapis.com/auth/drive.file'],['https://www.googleapis.com/auth/drive.readonly']]){
    assert.throws(()=>verifiedGoogleSubject({tokens:{idToken:'fixture-only',scopes},profile:{sub:'google-sub'}}),{message:'GOOGLE_REAUTH_REQUIRED'});
  }
});
test('verified provider hook returns only exact sub and does not require a new refresh response',()=>{
  // This unit fixture does not verify a JWT. The actual provider callback must establish that precondition.
  assert.equal(verifiedGoogleSubject({tokens:{idToken:'fixture-only',scopes:[...GOOGLE_SCOPES]},profile:{sub:'google-sub'}}),'google-sub');
  assert.equal(hasRequiredDriveScopes(['https://www.googleapis.com/auth/userinfo.email',...GOOGLE_SCOPES]),true);
  assert.throws(()=>verifiedGoogleSubject({tokens:{scopes:[...GOOGLE_SCOPES]},profile:{sub:'google-sub'}}),{message:'GOOGLE_REAUTH_REQUIRED'});
  assert.throws(()=>verifiedGoogleSubject({tokens:{idToken:'fixture-only',scopes:[...GOOGLE_SCOPES]},profile:{}}),{message:'GOOGLE_IDENTITY_INVALID'});
});
