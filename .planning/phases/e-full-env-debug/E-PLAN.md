# E — MartinLoop Full-Environment Debug + Hardening

Phase ID: `e-full-env-debug`
Date: 2026-06-26
Repo: `Keesan12/martin-loop` + `martin-Loop/ML_Core_OSS_Internal`
Branch: `fix/e-full-env-debug`

See full plan at: C:\Users\Torram\.claude\plans\hazy-jingling-mist.md

## Current Status

### Pre-flight
- [x] P.1 PR #145 merged (2026-06-26T17:27:16Z)
- [x] P.2 martin-loop upgraded 0.3.10 → 0.3.13
- [x] P.3 Baseline: 221/221 passing after fixing cli-integration.test.ts:347
  - Root cause of failure: governance gate reorder (PR #145) changed which error fires first
  - Fix: assertion updated to match governance-gate message ("Governed run blocked until MartinLoop receipts exist" + "martin-loop doctor")
- [x] P.4 Phase folder and debug session file created
- [x] P.5 Branch `fix/e-full-env-debug` created from public/main

### Slices
- [ ] E.0 Environment matrix reproduction
- [ ] E.1 Windows shim fix field verification
- [ ] E.2 MCP install + hook wiring audit
- [ ] E.3 Governance gate TTL audit
- [ ] E.4 autoBootstrapGovernedRun receipt persistence
- [ ] E.5 MCP server tool visibility + reload
- [ ] E.6 Cross-platform path hardening
- [ ] E.7 Tests for every failure found
- [ ] E.8 Version bump + release notes
- [ ] E.9 PR + merge + tag + publish
