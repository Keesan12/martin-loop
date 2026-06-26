# D.0-D.4 Nested Write Path Blocked in VS Code (Windows)

Date: 2026-06-26
Repo: `martin-loop`
Branch: `claude/martinloop-hero-image-a01s2b`
Trigger: field report (relayed via Gobi S) — "Martin's nested write path is still blocked, so
it cannot actually persist the edit from inside that governed run. Both Codex and Claude can
reason about the fix, but Martin's nested agent session is what's blocked from writing." User
clarified the failure is environment-specific: reproduces when MartinLoop runs nested inside
**VS Code** (Claude and Codex CLIs), not from a plain top-level **PowerShell** window, on
Windows.

## Hard constraints

- Do not regress the working PowerShell case.
- Do not regress non-Windows invocation paths (`linux`/`wsl`/`macos`).
- Do not touch any in-flight Routing Cost Control work in this branch.

## Root cause

On Windows, an npm-installed CLI (`codex`, `claude`) resolves to a generated `.cmd`/`.ps1` shim.
Both adapters' live execution funnels through the shared `createSpawnPlan()` in
`packages/adapters/src/cli-bridge.ts`, which previously always wrapped that shim through an
extra `cmd.exe /d /c` or `powershell.exe -File` hop before reaching the real Node process. Each
extra process hop is a place where the OS-level "workspace-write" sandbox permission can fail to
propagate to the grandchild process that performs the actual file write — a failure class the
codebase already fingerprints (`classifyProbeFailure` in `codex-launcher.ts`, signatures for
`CreateProcessAsUserW failed: 5`, "windows sandbox: runner error", read-only/approval-disabled
sandbox) but, until this fix, only used to abort a run with a remediation message rather than
work around it.

A bare top-level PowerShell window is a single, full-privilege process. Running the same shim
from inside VS Code adds at least one more process layer (VS Code → extension host / integrated
terminal → shim wrapper → real binary) on top of an already different security/job-object
context — consistent with the user's "works in PowerShell, not in VS Code" report and with the
sandbox-launch failure signatures already encoded in `classifyProbeFailure`.

## Slice plan

- D.0 Confirm the hypothesis via static analysis of the live execution path (`createSpawnPlan`,
  `buildProbeCommand`, `probeCodexLaunch`, `run-loop.ts`) — live Windows/VS Code repro is not
  possible from this remote Linux execution environment, so this is a documented limitation, not
  a skipped step.
- D.1 `createSpawnPlan` (`cli-bridge.ts`): when a Windows shim (`.cmd`/`.bat`/`.ps1`) would
  otherwise be wrapped through `cmd.exe`/`powershell.exe`, first try to statically resolve the
  shim's wrapped `node <script>.js` target (`resolveNpmShimScript`) and invoke that directly
  (`process.execPath` + script path). This removes one full process hop on every Windows launch
  for both adapters at once, since both funnel through this single chokepoint. Falls back to the
  existing wrapper behavior unchanged whenever shim parsing fails — no regression for shim
  formats this can't resolve.
- D.2 `codex-launcher.ts`'s `buildProbeCommand` (used by `probeCodexLaunch`) reuses the same
  `resolveNpmShimScript` helper so the *probe* exercises the same invocation depth as the real
  run. This keeps the probe and the real attempt's process-nesting shape consistent (previously
  the probe and run could diverge silently).
- D.3 Claude's adapter needed no separate shim-detection module: it already funnels through the
  same `createSpawnPlan`/`runSubprocess` chokepoint as Codex's adapter, so D.1 benefits both
  engines without duplicating Codex-specific logic into `claude-cli.ts`.
- D.4 `packages/core/src/index.ts`: add a new `sandbox_write_blocked` failure class
  (`packages/contracts/src/index.ts`) and classify an attempt as such when the adapter reports a
  completed patch with verification passed but zero changed files (`no_code_change`) *and* the
  adapter's own summary/failure text carries one of the known Windows sandbox-write-blocked
  signatures — instead of letting it silently fall through to the generic `no_progress` class.

## Verification minimums

- Targeted unit tests added for: `resolveNpmShimScript` shim-to-script resolution (`.cmd`/`.ps1`,
  unresolvable/missing-file fallback), `probeCodexLaunch` invoking the resolved script directly
  on a synthetic Windows shim, and the new `sandbox_write_blocked` classification path in core.
- Existing `@martin/adapters` and `@martin/core` suites pass with no regressions.
- Explicit non-regression check: non-`win32` platforms and unresolvable shims keep the exact
  prior behavior (`createSpawnPlan`/`buildProbeCommand` unchanged on those paths).
