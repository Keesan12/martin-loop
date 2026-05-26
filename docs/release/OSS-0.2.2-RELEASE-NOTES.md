# MartinLoop OSS `0.2.2` Release Notes

`martin-loop@0.2.2` ships the public OSS run-triage hardening and degraded run-store handling slice.

## Included

- missing explicit `runsDir` paths degrade diagnostic surfaces instead of failing path validation
- unreadable ledgers now surface partial-data warnings in verification and discovery outputs
- future-dated verification evidence is ignored and labeled as untrusted
- conflicting verification evidence for the latest attempt reports as unavailable
- live routed MCP inspection coverage now proves typed resource, prompt, and run-record handling together

## Not Included

- compact Context Diet resources
- prompt pack aliases
- MCP install-profile changes
- separate lifecycle or team evidence features
