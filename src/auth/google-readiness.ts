import { AuthBoundaryError, GOOGLE_ISSUER, GOOGLE_SCOPES, canonicalGoogleIdentity } from './config.ts';

const DRIVE_SCOPES = GOOGLE_SCOPES.filter(scope=>scope.startsWith('https://www.googleapis.com/auth/drive.'));
export function hasRequiredDriveScopes(scopes: readonly string[] | undefined): boolean {
  return !!scopes && DRIVE_SCOPES.every(scope=>scopes.includes(scope));
}

/**
 * GenericOAuth calls this public hook AFTER its ID-token signature/issuer/audience/nonce verification.
 * Keep its verified OIDC sub unchanged; inspect granted scope metadata, never exchange or persist tokens.
 * Better Auth 1.7.8 deliberately does not update account.scope on ordinary re-sign-in, so reject
 * partial grants before either new-account creation or replacement of existing credentials.
 */
export function verifiedGoogleSubject(context: {
  tokens: { idToken?: string | undefined; scopes?: string[] | undefined };
  profile: { sub?: unknown };
}): string {
  if (!context.tokens.idToken || !hasRequiredDriveScopes(context.tokens.scopes)) {
    throw new AuthBoundaryError('GOOGLE_REAUTH_REQUIRED');
  }
  return canonicalGoogleIdentity(GOOGLE_ISSUER,context.profile.sub).sub;
}
