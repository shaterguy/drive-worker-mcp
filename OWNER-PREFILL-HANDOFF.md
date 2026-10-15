# Owner-only initial folder prefill

Base: actual tested mount commit `e8977e3759fc19682ceacb2ef1ab7083238ae116`. This delta is source preparation only; no execution or deployment has occurred.

Optional private Production setting: `DWMCP_OWNER_PREFILL_JSON`. It is one JSON object with exactly five string keys: `issuer`, `sub`, `manualFolderId`, `commandsFolderId`, `resultsFolderId`. Issuer must be `https://accounts.google.com`; subject must be the existing verified Google subject. Folder IDs must match `[A-Za-z0-9_-]{1,256}` and be pairwise distinct. Unset means no prefill. Invalid, partial or extra-key configuration fails closed with a value-free error. The authenticated owner account and real folder IDs must never be added to public source, fixtures, command transcripts or reports.

Only a server-resolved Google identity from `Connections.list` can match the configuration. Email, request parameters and browser-supplied identity are not used. Other accounts receive blank fields. An existing saved binding wins. Prefilled fields remain editable, and only the explicit form submission supplies the normal `/ui/connect` input. There is no autosave, automatic grant, metadata-validation bypass or scope change. The existing session/origin/CSRF boundary, Google grant readiness, account-bound folder metadata and `canAddChildren` checks remain unchanged.

The setting contains account/folder identifiers, not authentication credentials. Parent configures its actual values privately only for the verified owner, with the user's existing authorization. No secret/token is introduced or exported. No dependency, SQL, OAuth scope, token policy, build target or deployment rewrite change is needed.

New fixtures use only synthetic identities and folder IDs: optional/atomic config, malformed config rejection, exact issuer/sub match, blank other-account forms, editable values, saved-binding precedence and escaping. Run these first for genuine missing-module RED, then the full suite/typecheck/build/schema-typecheck through the approved MANUAL Termux route after the game measurement window. Source/security review and actual execution evidence remain required before deployment.
