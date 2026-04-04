# Fresh Engineer Handoff

This pack is for a new engineer joining the Martin Loop rebuild after Phases 1-7 were completed in-repo.

Use this read order:

1. `SUMMARY.md`
2. `CURRENT-STATE.md`
3. `VERIFICATION.md`
4. `artifacts/phase7-go-no-go-report.md`
5. `NEXT-HARDENING.md`
6. `references/v6-hardening/`

What is included here:

- Current repo state summary
- Exact verification commands that were run successfully
- The latest Phase 7 go/no-go report artifacts
- A distilled hardening continuation plan based on the attached `martin-loop-complete-handoff-v6-hardening-pack.zip`
- Selected source hardening documents copied from that zip for direct reference

Cold-start commands for the next engineer:

```powershell
pnpm --filter @martin/control-plane lint
pnpm --filter @martin/control-plane test
pnpm --filter @martin/benchmarks lint
pnpm --filter @martin/benchmarks test
pnpm --filter @martin/benchmarks eval:phase7
```

Important environment note:

- `benchmarks` no longer uses `tsx` for the Phase 7 report command because Windows/esbuild startup hit `spawn EPERM` in this environment.
- `eval:phase7` intentionally runs `pnpm build && node dist/phase7-report.js` so the report can be reproduced reliably.
