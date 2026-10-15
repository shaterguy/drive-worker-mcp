import type { BetterAuthOptions } from 'better-auth/types';

/**
 * ID-token verification and subject selection finish before account persistence.
 * Better Auth 1.7.8 encryptOAuthTokens covers access/refresh tokens, not idToken.
 * Hooks merge partial data, so explicit null (not omission) prevents retention.
 * Return only that field: leave encrypted credentials, identity and omitted-refresh semantics untouched.
 */
export const accountPrivacyHooks = {
  account:{
    create:{before:async()=>({data:{idToken:null}})},
    update:{before:async()=>({data:{idToken:null}})},
  },
} satisfies NonNullable<BetterAuthOptions['databaseHooks']>;
