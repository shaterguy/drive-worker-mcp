# DriveWorker MCP auth candidate

Prepared source artifacts only. No product installation, build, test, migration, OAuth grant or deployment was performed in the cloud workspace.

## Two separate states

1. Initial scaffold: `api/index.ts`, `src/auth/config.ts`, `src/auth/health.ts`, `tests/auth-config.test.ts`, `vercel.auth-scaffold.json`. Health is liveness only; OAuth, discovery, UI and MCP return 503. This may establish a verified deployment hostname after the approved Termux typecheck/build passes. The latest rewrite template adds the reviewed public-output/install boundary; the four initial TypeScript files remain unchanged.
2. Follow-up candidate: remaining auth files and SQL. `createRuntime()` is NOT mounted by the entrypoint. Copying these files does not activate auth. Never describe this state as user-ready.

## Integration contract

- Core source stays owned by the core builder. Tenant table is `dw_mcp_tenants(id)`.
- `createRuntime(config,pool,cursorKey)` returns `{auth,authority,connections,fetch}`. Use only after reviewed migration and the gates below; do not add a simple environment switch that accidentally activates untested routes.
- `cursorKey` must be stable, at least 32 bytes, and enter through the approved secret-storage handoff. No secret value is present in this artifact.
- `dependency-additions.json` contains four exact Better Auth 1.7.8 additions and development-only Kysely 0.29.6. PGlite 0.5.10 already exists in core's actual lock. Verify the new Kysely package's registry metadata and resolved integrity in the next approved packet. `@better-auth/oauth-provider` supplies public helper functions only; `mcp()` is the only provider plugin. Official MCP SDK v2.3.1 remains in core.
- Existing package scripts may typecheck/build all candidate files while the static 503 entrypoint remains active. Use the JavaScript-distributed TypeScript compiler `typescript@6.0.3` on Termux; the TypeScript 7 native compiler is not the current supported recovery route. Runtime remains Node.js 24. Do not run these scripts in the cloud artifact workspace.
- Runtime rewrites are in `vercel.runtime-candidate.json`; use the scaffold rewrite file for the initial deployment.
- Both templates restrict static output to `public` and use the core builder's lockfile-only, scripts-disabled official-registry install command. Core owns the actual root `vercel.json` and `public/robots.txt`; auth integration must not overwrite that root configuration automatically.

## Trusted configuration

No production hostname is selected. After actual Vercel alias verification, configure `DWMCP_PUBLIC_ORIGIN=https://<verified-host>`. The exact Google redirect URI is that origin plus `/api/auth/callback/google`. Issuer is origin plus `/api/auth`; resource is origin plus `/mcp`. Neither is inferred from request headers.

Required private runtime values: `DATABASE_URL`, `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and the stable cursor key. The user enters/submits credentials and Google OAuth grants through a secure handoff. Never include them in command JSON, command output, source control, screenshots or chat.

## Migration ordering

1. In the approved Termux route, install exact packages, run all tests and the ordinary typecheck/build, then `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.auth-schema.json`. No runtime secrets are needed for generation.
2. Run `node scripts/generate-auth-schema.ts` only in that route. It uses the public `better-auth/db/migration` getMigrations/compileMigrations API used by the official CLI, with Kysely's maintained PGliteDialect and an empty in-memory PostgreSQL schema. The shared `createAuthOptions` factory supplies the identical plugin/schema options. `scripts/schema-config.ts` exports `createSchemaOptions(database)` with unusable public fixtures and throwing application hooks; it never constructs `betterAuth()` or loads environment files.
3. The generator checks exact installed versions, compiles official SQL, applies those exact bytes only to the isolated PGlite database, requires an empty second migration plan, and locally applies app auth/core DDL. It writes `sql/generated/better-auth-1.7.8.sql` and `sql/generated/schema-report.json` exclusively. No generated SQL has been produced or passed these checks yet. An existing output is an error, not permission to overwrite reviewed SQL.
4. Retrieve and inspect both artifacts. Review generated PostgreSQL column names/types and FKs, especially `oauthConsent` JSONB scopes/resources and refresh/access-token references. Compare all three SQL hashes in the report. Do not substitute handwritten Better Auth tables. The official migration output is kept byte-for-byte, without app DDL mixed into it.
5. Parent may apply the reviewed official SQL, then `sql/auth.sql`, then core schema to the new dedicated Neon database using the already authorized plugin. This avoids transferring Neon credentials to a command. The app script is first-application DDL, not an idempotent rerun script. Check the target is the intended empty service schema first.
6. Inspect actual Neon table/trigger/FK presence and run transaction/rotation tests before mounting runtime. PGlite local DDL success cannot establish two-connection races, Neon compatibility, OAuth, or ChatGPT readiness.

The official CLI's Kysely generator introspects its configured database; `--dialect postgresql` does not make it offline. Its config loader also reads environment files and a conventional exported `auth = betterAuth(...)` may start the OIDC context. The maintained public migration API above avoids those side effects without replacing any Better Auth table definitions. Production still uses `pg`, not PGlite.

## Security behavior implemented in candidate

- Maintained genericOAuth with fixed Google discovery, verified ID token, PKCE and nonce; no implicit email linking. Its public accountSubject hook runs after the library's provider verification, requires an ID token and both actual granted Drive scopes, and returns only the unchanged verified profile.sub. No custom exchange/userinfo/JWT verification. Missing or partial granted scope metadata rejects before account/token persistence. This prevents Better Auth 1.7.8's deliberate omission of ordinary sign-in scope updates from accepting stale partial grants in this new empty service.
- The shared metadata-only Google readiness check requires the stored refresh to exist and both Drive scopes at setup, token issuance, and every tool. Existing bindings cannot bypass it. Identity scope alias changes are allowed. A fresh response that omits refreshToken preserves Better Auth's existing stored value; null/empty responses are not claimed to preserve it. A first login without any durable refresh is blocked with GOOGLE_REAUTH_REQUIRED. Re-consent is user initiated. This checks the last accepted grant metadata, not Google's live authorization state; external Google revocation must fail closed through provider refresh/Drive API failures and needs an actual fixture.
- Better Auth encrypts Google access/refresh tokens durably. Its 1.7.8 encryptOAuthTokens setting does not encrypt account.idToken. The maintained account create/update before hooks set only idToken to null after provider validation, avoiding unnecessary retention without changing token encryption or identity. Provider-initiated/global Google logout is disabled; app sign-out still deletes the local session. Stored ID tokens are not required for Google refresh or the app's Drive operations. Actual persistence/refresh tests remain required.
- Server-only access-token lookup uses the exact stored Better Auth account ID AND user ID. HTTP token-export/link endpoints are disabled and absent from the router allowlist. A newly returned provider ID token may exist transiently inside Better Auth during refresh; the application consumes only accessToken and never logs the result object.
- Login, consent and continuation use library-signed `oauth_query`. HTML escapes untrusted text, has CSP nonces and same-origin POSTs. Drive.readonly breadth is disclosed before Google consent.
- Folder IDs are user-bound, validated against that account, and inserted only once. Reconnecting the same Google identity preserves bindings. Initial folder metadata/capability validation is not a promise that `drive.file` can write to an existing folder; a real write permission test remains mandatory.
- JWT signature/issuer/audience/expiry and DPoP use the maintained MCP library. Every tool checks committed grant/consent/client/session state again. Resource audience is required; only the exact resource and issuer UserInfo audience are allowed.
- App grants use the original session ID as immutable reference. Session and refresh lifetime are explicitly seven days. Reference-session checks survive the library FK setting refresh sid to null after session deletion. Expiry requires fresh Google sign-in, preserving saved bindings.
- Consent deletion or scope/resource reduction and actual refresh revoke/family deletion tombstone the grant. Tombstones cannot reactivate. Connection disconnect removes corresponding consent and refresh/access rows transactionally, preserves Drive/tenant/bindings, and requires a fresh sign-in session to reconnect.
- Strict refresh reuse interval is zero. Library v1.7.8 rejects a losing concurrent rotation, but its documented CAS-loser path does not itself synchronously invalidate the winning family. Do not claim that application triggers fix that library limitation. Sequential replay, explicit revoke and committed tombstone interleavings require actual evidence.
- Request-local known-secret redaction adds newly refreshed Google access tokens. Google refresh plaintext never leaves Better Auth into application redactor state. This is not a guarantee of detecting all arbitrary secrets embedded in external logs.

## Required acceptance evidence

- Actual registry/lockfile, `npm test`, `npm run typecheck`, `npm run build` via approved MANUAL Termux route. No source-inspection result substitutes for execution.
- Verified Vercel Node24/TypeScript6.0.3 deployment, rewrites and exact callback; no host or forwarded-host poisoning. No-token MCP challenge; every discovery alias and JWKS. User-ready remains false until full tests pass.
- Real two-Google-account isolation, verified issuer/sub, same-account remove/re-register restoration, different-account switch, no email linking, provider token refresh after process restart, no token/secret output.
- First partial scope (each missing Drive scope), missing token-response scope/ID token, first login with no refresh, same-account omitted-refresh preservation, empty/null refresh negative cases, explicit re-consent recovery, and existing-binding reduced-scope sign-in rejected before credential replacement. Unit metadata fixtures are not evidence of actual Better Auth persistence or Google's response shape.
- Actual callback and provider refresh storage must show access/refresh ciphertext, account.idToken null, and unchanged subject/binding. `auth-account-privacy.test.ts` exercises the maintained memory-adapter hook path with synthetic markers only; it does not prove encryption, PostgreSQL behavior, or a real Google callback. Sign-in/refresh/sign-out without a retained ID token and no token-bearing logs are acceptance gates.
- Google cancel/error, invalid state/nonce/PKCE, missing/incorrect resource/audience/issuer/expiry/signature, malicious signed-query edits, unverified provider input, client-supplied extra auth parameters, disabled token-export/link APIs.
- Real ChatGPT CIMD plural auth methods fixture, SSRF/redirect/private-IP/rebinding fixtures against pinned Node transport, RFC9207 issuer on success/error, exact current callback from client UI, actual MCP version negotiation. Do not require legacy rejection before the actual client's protocol is established.
- Per-tool scopes and 403 insufficient_scope HTTP challenge for single calls and accepted batches. `tests/auth-protected-mcp.test.ts` uses the actual maintained requireMcpAuth verification path with a test-only RSA signature and stubbed JWKS/DB transport; its 401/403/allowed-call fixtures are authored, not run. Batch preflight cannot replace individual tool grant checks.
- PostgreSQL two-connection rotation/revoke ordering, duplicate refresh, code replay, client disable, consent delete, scope/resource shrink then re-expand, unchanged/update-order consent (must not revoke), immutable tombstone, new-session reconnect, expired/deleted session with nullable sid, DB outage, restart.
- Generated schema FK behavior, authenticated owner-only disconnect, and no rollback that silently keeps a supposedly disconnected grant alive.
- Real folder access and write permission, wrong/trashed folder, missing refresh/scope, binding preservation, no owner fallback; no test submits executable commands without explicit approved scope.

## Primary references checked

- https://better-auth.com/docs/plugins/mcp
- https://better-auth.com/docs/plugins/cimd
- https://better-auth.com/docs/plugins/generic-oauth
- https://better-auth.com/docs/plugins/oauth-provider
- https://better-auth.com/docs/concepts/cli
- https://better-auth.com/docs/adapters/other-relational-databases
- https://github.com/better-auth/better-auth/blob/v1.7.8/packages/cli/src/generators/kysely.ts
- https://github.com/better-auth/better-auth/blob/v1.7.8/packages/better-auth/src/db/get-migration.ts
- https://github.com/better-auth/better-auth/blob/v1.7.8/packages/better-auth/src/oauth2/link-account.ts
- https://github.com/better-auth/better-auth/blob/v1.7.8/packages/better-auth/src/api/routes/callback.ts
- https://github.com/better-auth/better-auth/blob/v1.7.8/packages/better-auth/src/db/with-hooks.ts
- https://github.com/better-auth/better-auth/blob/v1.7.8/packages/better-auth/src/api/routes/account.ts
- https://better-auth.com/docs/concepts/database#database-hooks
- https://github.com/kysely-org/kysely/blob/v0.29.6/src/dialect/pglite/pglite-dialect.ts
- https://github.com/better-auth/better-auth/tree/v1.7.8/packages/oauth-provider/src
- https://vercel.com/docs/functions/runtimes/node-js
- https://developers.google.com/workspace/drive/api/guides/api-specific-auth

This handoff describes code and remaining gates, not passed test results.
