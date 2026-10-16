# Upstream errors in v0.1.0-dev4

This change classifies future Google Drive failures. It does not establish the cause of any earlier incident whose upstream reason was discarded.

## Classification

Only exact values in bounded JSON `error.errors[].reason` are accepted for HTTP 403. The body limit remains 16 KiB. Missing, unknown, mixed-category, or malformed reasons produce `UPSTREAM_FORBIDDEN_UNKNOWN`, never a blanket permission diagnosis. Unknown values are not echoed. Multiple known reasons mapping to the same category select the lexically first allowlisted reason for one deterministic record.

- `insufficientPermissions`: `INSUFFICIENT_SCOPE`
- `rateLimitExceeded`, `userRateLimitExceeded`: `UPSTREAM_RATE_LIMITED`
- `dailyLimitExceeded`, `storageQuotaExceeded`, `activeItemCreationLimitExceeded`, `teamDriveFileLimitExceeded`, `numChildrenInNonRootLimitExceeded`: `UPSTREAM_QUOTA_EXCEEDED`
- `insufficientFilePermissions`, `teamDriveMembershipRequired`: `DRIVE_PERMISSION_DENIED`
- `appNotAuthorizedToFile`: `DRIVE_APP_NOT_AUTHORIZED`
- `domainPolicy`: `DRIVE_DOMAIN_POLICY`

Other existing HTTP status mappings remain unchanged. No 403 automatic retry is added. Network failures and 429/5xx retain the existing three-attempt bound, backoff, Retry-After handling and fixed reserved ID.

## Safe tool errors

Relevant errors retain their original `code` and add fixed `category`, `retryable`, and `action`. The two read tools may indicate bounded re-reading for transient/unknown failures, always for the same job. This is guidance to callers, not an automatic retry implementation. Scope, permission, app access, domain policy, quota and missing-resource failures are non-retryable without resolving the relevant condition.

The two publication tools always return `retryable: false` on these errors. Their action includes a fixed cause-specific remedy, existing-job inspection and reconciliation using the identical job ID, body and route. It prohibits new jobs or route switching. A failure after a durable reservation retains `UNKNOWN` and the existing reserved file ID; new error categories do not turn an uncertain write into a confirmed failure. A wrapped `SUBMISSION_OUTCOME_UNKNOWN` may include allowlisted `upstream_code` and the original correlation ID. Reconciliation does not create a replacement file or infer Worker success. Existing specialized error-code propagation remains unchanged.

## Closed diagnostic schema

One terminal Google HTTP failure emits at most one JSON line with exactly these keys:

- `event`: `dwmcp_upstream_v1`
- `operation`: `get_metadata`, `reserve_file_id`, `create_json`, `read_bytes`, or `find_exact`
- `http_status`: integer HTTP response status
- `reason`: one exact allowlisted reason above, `unknown`, or `unparseable`
- `code`: a static upstream error code
- `correlation_id`: application-generated random UUIDv4, shared with the tool error

The serialized record is capped at 512 UTF-8 bytes. No incoming or provider request ID is copied. ID-generation failure or an invalid generated value omits the correlation ID and record without changing the classified error. Synchronous/asynchronous logger failure cannot change the response or trigger a fallback log. There is no shared mutable correlation state.

Excluded from the new error fields and records: arbitrary reason strings, error message/stack/cause, raw bodies, tokens, cookies, headers, URLs, querystrings, account/tenant/client/job/folder/file identifiers, commands, environment values and stdin. The entire error body is discarded after bounded classification.

Success responses, expected metadata 404 absence and successful retries emit no upstream record. A failed create returning 409 may emit a record even when exact-ID reconciliation subsequently succeeds; the record describes that Google response, not final tool or Worker failure. Network/token-acquisition failures without an HTTP response retain their existing safe error code and have no upstream HTTP record or invented status. A diagnostic ID does not prove that a log sink retained the record.

Existing `dwmcp_boundary_v1` telemetry is unchanged, including its no-correlation-ID schema and HTTP-level outcomes. HTTP 200 can still contain a tool error. These records do not instrument OAuth internals or identify failures that never reach the application.

## Verification boundaries

Use the authorized Termux MANUAL route for product execution. Synthetic tests cover exact/unknown reasons, bounded parsing, full-output private marker exclusion, logger/ID failure isolation, concurrent ID separation, no 403 retry, existing transient retries, fixed-ID 409 reconciliation, UNKNOWN cause preservation and all four official SDK tool boundaries. Existing authorization, tenant isolation, grant checks, schema, Worker behavior and boundary tests remain required. Independent review and reviewed deployment are separate from implementation self-checks.

Official reason reference: https://developers.google.com/workspace/drive/api/guides/handle-errors
