# MartinLoop 0.7.1 — Actionable Hosted Sync Errors

`martin sync flush` now reports safe, actionable rejection details returned by the hosted service instead of reducing failures to a generic pending count.

Repairable authentication, entitlement, and scope failures keep the signed run queued. After credentials or scopes are corrected, the same evidence can be uploaded without rerunning the provider. Conflict, rate-limit, temporary server, and network failures are also classified clearly, while tokens, signing secrets, authorization headers, and arbitrary response fields remain hidden.
