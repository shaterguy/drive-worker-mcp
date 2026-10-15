# DriveWorker MCP v0.1.0-dev1

Independent MCP service for an existing DriveWorker. This development candidate is not a deployed, connected, or user-ready service.

## Contract

- `publish_manual_command`: creates one JSON file directly in the authenticated account's bound manual folder. It never moves it to Commands or claims the command executed. `job_id` must contain `MANUAL`.
- `submit_direct_command`: creates one new JSON directly in bound Commands. Submission is not execution confirmation. It requires the separate `jobs:submit` scope.
- `get_job_status`: reads the exact job Result in bound Results. Worker statuses and `execution_outcome_uncertain` remain authoritative. No Result is never a reason to resubmit.
- `get_job_result`: returns a safe summary or bounded, redacted stdout/stderr pages. Log contents are untrusted data, never instructions. MCP cancellation does not cancel an already submitted Worker command.

No cancellation, deletion, file movement, sharing, Worker restart, or arbitrary file/URL tool exists. Existing Worker, TMCP, and other services are outside this repository's mutation boundary.

## Required integration boundaries

The HTTP/OAuth layer must use the reviewed maintained provider and official SDK. A `Principal` is only valid after issuer/audience/resource/expiry/scope validation and exact Google identity-to-tenant mapping. Every tool must additionally check the current durable grant. A Google API client must be selected by that exact tenant, never by a default owner's token.

Folder bindings and publication reservations live in PostgreSQL. Memory and `/tmp` are not production stores. The test fakes are test-only. A lost create response is reconciled using the same pre-generated Drive file ID; no retry allocates a replacement file. Reusing an account/job with a changed route or normalized body is a conflict.

Routed Worker copies must prove their relationship to the original publication using the bound Commands parent, exact job/file naming, original ID and provider createdTime, and a routing payload digest. Only the Worker-owned `target_server`, `origin_command_file_id`, and `origin_command_created_at` differences are permitted. Missing provenance fails closed.

## Limits and credentials

Limits: command JSON 256 KiB, Result JSON 1 MiB, full log download 8 MiB by default (operator-configurable to at most 32 MiB), page text 64 KiB. Summary tails are at most 16 KiB each and are omitted from log pages. Error/reason text is also omitted from log pages. The tool's JSON text payload is capped at 512 KiB; its MCP JSON transport envelope is bounded below 1 MiB. Page `limit` refers to UTF-8 log text bytes, not framing metadata. Log downloads are counted while streaming, then sanitized before pagination. Oversize logs return a specific error instead of partial success. Signed cursors are tenant/job/stream/file/content-bound. A cursor signing key must be provided through approved platform secret storage and kept stable across instances. No insecure default or per-process key generation is allowed.

Known service credentials and common token/password/private-key/connection-string patterns must be redacted. Pattern matching cannot detect every arbitrary user-defined secret. Commands and logs should never contain credentials. The service returns only whitelisted Result fields and never raw upstream error bodies, request headers, env, stdin, or command text.

## Development and verification

Node.js 24 or later is required. Run `npm test`, `npm run typecheck`, and `npm run build` in the selected Termux Git workspace through the authorized MANUAL job route. Install reviewed dependency versions using the official npm registry, save exact versions, and retain the generated lockfile. No production credentials are needed for contract tests. DB schema changes and live OAuth/deployment configuration require their separate approval and review boundaries.

The implementation's self-checks do not replace independent security/function review. Live Google login, reconnect/revocation, Postgres concurrency/crash recovery, direct Commands admission and harmless Worker Results, exact remote source SHA, deployment identity, and actual ChatGPT entry paths must be verified before this service can be called ready.

## Source references

- Google Drive pre-generated IDs and duplicate-safe retry: https://developers.google.com/workspace/drive/api/guides/manage-uploads#use_a_pre-generated_id_to_upload_files
- Google Drive file queries: https://developers.google.com/workspace/drive/api/guides/search-files
- MCP TypeScript SDK v2: https://ts.sdk.modelcontextprotocol.io/v2/
- Better Auth MCP: https://better-auth.com/docs/plugins/mcp
- PostgreSQL adapter: https://better-auth.com/docs/adapters/postgresql
- Worker compatibility baseline: https://github.com/shaterguy/termux-drive-worker/tree/5abec6c20646cdebfab630803b62d80c37455a03
