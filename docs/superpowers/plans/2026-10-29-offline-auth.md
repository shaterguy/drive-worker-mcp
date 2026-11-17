# Durable offline authentication implementation plan

Goal: preserve approved offline connections beyond browser login expiry.
Spec: ../specs/2026-10-29-offline-auth-design.md
Architecture: retain the official Better Auth lifecycle and existing PostgreSQL grant/consent authority. Change only the app session gate and rolling MCP refresh TTL.

- [x] Add authority regression tests for expired/deleted sessions, offline consent and retained revocation/lineage; observe AUTH_REQUIRED failures before implementation.
- [x] Return validated offline eligibility from requireConsent; retain initial-code and online-only session checks.
- [x] Set refresh rotation inactivity lifetime to 90 days and update existing UI and auth documentation consistently.
- [ ] Test the actual provider, app authority and database together through expired/deleted session refresh and revocation.
- [ ] Run the repository suite, typecheck and build on final source, then independent auth/security review.
- [ ] Preserve exact source on GitHub and deploy the new candidate to the existing production URL; verify current MCP connectivity and rotation readback.

Review focus: stored consent reduction, explicit revocation, nullable sid after actual FK deletion, existing connections issued with the old lifetime, and stale Google metadata versus successful refresh. These are covered by authority, integration, rotation and live readback checks. No production token values are printed or copied.
