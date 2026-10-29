# Durable offline authentication

User request: 다시 인증했어. 근데 다시는 이런 재인증이 발생하지 않도록 해줘

Goal: remove application-induced periodic reauthentication during normal use, preserving existing grants, Google identity, folders, revocation and refresh replay protections.

Evidence: stored Google refresh expiry remained in the past after renewed sign-in. A controlled access-expiry test nevertheless refreshed the real Google token and read the existing job successfully. The old expiry metadata is not sufficient to diagnose token failure. Separately, authority.ts unconditionally requires the original seven-day browser session even for durable offline consent, contrary to the maintained provider's offline lifecycle.

Chosen approach: require a live session for the initial code exchange and online-only grants. For refresh and tools, derive offline eligibility from the currently validated durable consent. Keep original reference and any present sid matching, plus Google readiness, tenant, client, grant and consent checks. Rotate MCP refresh tokens to a new 90-day inactivity deadline. Existing connections benefit on their next refresh, without token migration or credential copying.

Alternatives rejected: extending browser session rows indefinitely couples offline authorization to login and requires persistent date repair; removing all session/consent checks would weaken initial authentication and revocation. No new service, cron, scope, token store or dependency is needed.

AC-01: offline grants survive browser-session expiry/deletion, including FK sid=NULL, with original lineage intact.
AC-02: normal MCP refresh rotates to a current-time 90-day deadline; existing connection remains usable.
SAFE-01: code exchange, online-only grants, tenant/client/resource/scope mismatch and sid mismatch retain their checks.
SAFE-02: disconnect, revoke, consent removal/reduction and missing Google readiness still deny access.
REL-01: exact dev6 source is preserved on GitHub, reviewed, deployed and checked through the existing connected MCP.

Google controls actual token revocation, Testing-mode expiry and time-limited grants. These must be investigated independently, never bypassed or reported as permanently prevented. No source of production credentials is added to the repository.
