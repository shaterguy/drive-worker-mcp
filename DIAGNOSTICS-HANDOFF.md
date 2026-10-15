# Boundary diagnostics, v0.1.0-dev2

## Candidate status

This source candidate adds bounded request-local observations to the existing authentication boundary. It does not establish the cause of the earlier parallel-query failures. The approved isolated MANUAL Termux RED completed with exit 1: the unchanged baseline lacks the new diagnostic module and runtime-router export. Both test hashes and preservation of the original checkout were confirmed. The first isolated GREEN attempt reported 92/96 passing with all three TypeScript stages passing and the original checkout preserved. Three new boundary subtests (plus their parent) failed because the fixture sent malformed authorization instead of omitting the header, and its synthetic token endpoint omitted the maintained form-media declaration. This revision corrects only that test file and this status note; production and version files are unchanged. It retains a separate malformed-authorization assertion. The revised full GREEN remains pending. No product test or build was run in the artifact-preparation environment.

The preceding isolated concurrency characterization passed strict typing and four reported tests with synthetic dependencies. Its three-slot FIFO model demonstrates a possible pre-handler HTTP 503 path; it does not exercise the actual PostgreSQL driver, platform latency or connector error normalization.

## Exact output

Only exact pathnames `/mcp` and `/api/auth/oauth2/token` create a request-local diagnostic context. Each returns at most one JSON completion line, when the application obtains its existing Response. The response body/stream is neither read nor awaited by diagnostics. The default sink prints that JSON string. No entry record, generated correlation ID, new environment setting or database table is added.

Required fields:

- `event`: `dwmcp_boundary_v1`.
- `route`: `mcp` or `oauth_token`.
- `phase`: `boundary`, `runtime_init`, `token_verification`, `principal`, `scope_preflight`, `sdk_dispatch` or `oauth_token`.
- `outcome`: `http_2xx`, `http_3xx`, `request_rejected`, `auth_required`, `forbidden`, `unavailable` or `other_http`.
- `http_status`: existing HTTP response status.
- `duration_ms`: monotonic elapsed milliseconds, rounded and clamped to 0–600000.

Optional fields:

- `principal_read`: `tenant`, `google_ready`, `grant`, `consent` or `session`, only when that initial pre-handler authorization step fails. It identifies a step, not a database error code or proven root cause. `google_ready` checks stored readiness metadata; it is not a Google network request.
- `pool_total`, `pool_idle`, `pool_waiting`: all three finite integer counts, clamped to 0–65535. Initial principal failures capture counts at failure; other responses capture them at completion. Uninitialized or invalid snapshots omit all three.

The record is a fresh closed projection with a 1024-byte UTF-8 limit. It cannot accept a request, response, exception or arbitrary object to serialize. Invalid phase/read labels are ignored. Snapshot, clock and sink errors cannot change the original authorization result or HTTP response and have no fallback log.

Excluded data includes all headers, cookies, URLs/query strings, request/response bodies, access/refresh tokens, client assertions, secrets, private keys, SQL/parameters, exception messages/causes/stacks, claims, identity/email/subject and tenant/client/grant/job/folder/request IDs. Public JWKS, health, login, connection and unrelated paths emit no diagnostic line.

## Behavior retained

The existing maintained authentication verifier, challenge statuses/headers, redirects/cookies, request size/origin guards, every-request and every-tool live grant checks, scopes, issuer/resource checks, token/session lifetimes, database pool size and timeouts remain in place. No retry, authorization cache, scope expansion, new dependency or SQL migration is introduced. The three app-version metadata locations advance together; dependency versions and integrity values are unchanged.

The runtime's existing HTTP routing is factored into a dependency-injected helper in the same source file to test its actual boundaries without production credentials or network. The production route and tests use the same helper. Per-request verifier closures carry their own context; no shared current-request state or identity-keyed telemetry map is used. Every-tool grant validation retains the same reads but does not emit individual read labels.

HTTP 200 is classified as `http_2xx` even when its tool result has `isError`; diagnostics do not inspect semantic results. The final phase on HTTP 503 narrows where the application returned its error, but does not prove why it failed. An absent completion line cannot distinguish a request that never arrived, a process termination, a failed log sink or another pre-completion interruption.

## Acceptance

Two new test files cover exact route selection, closed projection, finite bounds, idempotence, throwing sinks/snapshots, each initial read failure, account isolation under 13 mixed concurrent requests, simultaneous token traffic, unchanged per-tool checks, sanitized failures, maintained challenges/redirects/cookies and unchanged success bodies. All identifiers and credentials in these fixtures are synthetic. Their fixed network fixture accepts only the synthetic issuer's public JWKS URL.

The RED stage applies only the two tests to an isolated unchanged checkout. Expected failures are absent new module/export, not syntax errors. The GREEN stage applies the reviewed production/version delta only to an isolated copy and runs new and existing tests plus strict typecheck/build/schema typecheck. The original checkout is preserved; canonical source application, commit and push require the separate reviewed continuation after evidence review. Actual results belong in the execution evidence; this candidate document alone is not a passing-test claim.

After reviewed deployment, use only the already approved bounded existing-job read calls and inspect fixed phase/status counts. The original incident remains unattributed until live observations provide sufficient evidence. Do not expand endpoint probes, retrieve credentials, increase pool/timeouts, weaken authorization checks or alter persistent access as part of this change.
