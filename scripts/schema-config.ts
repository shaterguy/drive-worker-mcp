import { createAuthOptions, type AuthApplicationHooks } from '../src/auth/better-auth.ts';
import type { AuthConfig } from '../src/auth/config.ts';

// Deliberately public, unusable fixtures. Never load .env or copy a runtime configuration here.
const schemaFixture: AuthConfig = Object.freeze({
  origin:'https://schema-only.invalid',
  issuer:'https://schema-only.invalid/api/auth',
  resource:'https://schema-only.invalid/mcp',
  googleCallback:'https://schema-only.invalid/api/auth/callback/google',
  databaseUrl:'unused-in-memory-database',
  secret:'schema-generation-public-fixture-never-use-for-authentication',
  googleClientId:'schema-generation.invalid',
  googleClientSecret:'schema-generation-public-placeholder',
});
const forbidden = async (): Promise<never> => { throw new Error('SCHEMA_ONLY_HOOK_CALLED'); };
const hooks: AuthApplicationHooks = {consentReference:forbidden,issueClaims:forbidden,isBindingMissing:forbidden};

/** Exact production plugin/schema options, without constructing betterAuth() or an auth context. */
export function createSchemaOptions(database: Parameters<typeof createAuthOptions>[1]) {
  return createAuthOptions(schemaFixture,database,hooks);
}
