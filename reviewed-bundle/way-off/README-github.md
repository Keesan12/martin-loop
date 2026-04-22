<div align="center">

<img src="docs/assets/martin-loop-hero.svg" alt="MartinLoop" width="100%">

# MartinLoop

**AI coding with brakes. The control plane your agents actually need.**

[![Tests](https://img.shields.io/badge/tests-417%20passing-brightgreen?style=flat-square&logo=checkmarx)](https://github.com/Keesan12/MartinLoop)
[![Gate Checks](https://img.shields.io/badge/gate%20checks-63%2F63-brightgreen?style=flat-square)](./benchmarks)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square)](./tsconfig.json)
[![Node](https://img.shields.io/badge/node-%3E%3D20-green?style=flat-square)](#quick-start)
[![SLSA](https://img.shields.io/badge/SLSA-Build%20Level%203-purple?style=flat-square)](./SLSA.md)
[![npm](https://img.shields.io/badge/npm-martin--loop-red?style=flat-square&logo=npm)](https://npmjs.com/package/martin-loop)
[![by MartinLoop](https://img.shields.io/badge/by-martinloop.com-0f766e?style=flat-square)](https://martinloop.com)

---

**Your overnight pipeline estimated $2.40.**  
**You woke up to $165.**

An AI agent ran 47 retries with no hard stop, no filesystem rollback, and no audit trail.  
Nothing merged. Just a bill.

**MartinLoop exists so that never happens again.**

```sh
npm install -g @martin/cli
```

[**martinloop.com**](https://martinloop.com) · [**Demo**](https://martinloop.com/demo) · [**Benchmark**](https://martinloop.com/benchmark) · [**Docs**](https://martinloop.com/docs)

</div>

---

## Why MartinLoop?

Three things ruin overnight AI runs. MartinLoop fixes all three.

| The problem | What breaks | MartinLoop's fix |
|---|---|---|
| 🌃 **The 3am surprise** | Agent retried 47× overnight. Billed $165. Nothing shipped. | Hard USD kill switch — cap is a kill signal, not a warning |
| 🔥 **The invisible bill** | 70% of tokens are waste on average agent runs | 14-class pre-execution leash + delta re-prompting |
| 🕳️ **No receipt, no audit** | Can't replay what went wrong. No signed artifact. | Ed25519-signed audit trail per run — verifiable offline |

---

## Quick Start

```sh
# Install the CLI
npm install -g @martin/cli

# Check your system is ready
martin doctor

# Run a governed task
martin run "fix the auth regression" \
  --budget 3.00 \
  --verify "pnpm test"

# ✓ Budget cap: $3.00 hard stop (not a warning — the loop stops)
# ✓ Leash: 14 classes armed — pre-execution, never post-execution
# ✓ Verifier: pnpm test → grade A
# ✓ Signed: Ed25519 audit trail
# Cost this run: $1.19 / $3.00 cap

# Replay any run decision
martin explain <loopId> --timeline --html

# Resume an interrupted overnight run
martin resume <loopId>

# Verify the audit trail is tamper-evident
martin audit verify <loopId>
```

Or use the SDK directly:

```typescript
import { MartinLoop } from 'martin-loop'

const loop = new MartinLoop({
  budgetUsd: 3.00,        // Hard stop — subprocess killed at limit
  leash: true,            // 14-class adversarial gate, pre-execution
  audit: { sign: true },  // Ed25519-signed per attempt
  verify: 'pnpm test'     // Grade A/B/C from actual test output
})

const result = await loop.run('fix the auth regression')
// result.grade       → 'A'
// result.costUsd     → 1.19
// result.auditId     → 'abc123...' (Ed25519 signed, verifiable offline)
// result.filesWritten → 3 (or 0 on blocked/failed attempts)
```

---

## Policy-as-Code

Drop a `martin.policy.yaml` in your repo root. Committed, versioned, reviewable.

```yaml
# martin.policy.yaml
budget:
  hard_cap_usd: 5.00      # Hard stop. Not a warning.
  warn_at_pct: 70

leash:
  block_rm_rf: true
  block_pipe_to_bash: true
  block_git_force_push: true
  allowed_surfaces:
    - packages/*/src/**
    - packages/*/tests/**
  blocked_paths:
    - .env
    - secrets/**
    - "*.pem"

audit:
  sign: true
  export_siem: false       # Set SIEM endpoint to stream OCSF/CEF events
```

---

## Five Guarantees (All Backed by Tests)

**1. Writes to forbidden paths never reach disk.**
The Autonomy Envelope validates every file operation against the configured surface and path leash before execution. Violations are rejected and logged. `12/12 safe task scenarios pass`.

**2. Forbidden shell commands are blocked pre-execution.**
The command leash checks against a 14-class deny list. No subprocess is spawned for a blocked command. `63/63 adversarial gate checks passing. 0 false positives.`

**3. Agent memory is gated before it influences decisions.**
New memory candidates move through shadow evaluation and a holdout comparison before the approval gate promotes them to active recall.

**4. Every action is signed.**
The audit trail uses Ed25519 keys. Entries cannot be modified without invalidating the signature. Verifiable offline with `martin audit verify`.

**5. Model routing decisions are observable.**
Every routing call emits a `martin.router_decision` OTel span with the selected model, priority tier, and estimated cost. No silent fallbacks.

---

## Benchmark Results · 2026-04-14

> Same 10 tasks. Same verifier commands. Three runners. Deterministic fixtures. Reproducible by anyone.

| Runner | Correct Outcomes | Verified Patches | Unsafe Outcomes | Total Cost (10 tasks) | Per Task |
|--------|:---:|:---:|:---:|:---:|:---:|
| **MartinLoop ★** | **10/10** | **8/10** | **0** | **$11.90** | **$1.19** |
| Ralphy | 5/10 | 5/10 | 1 | $24.00 | $2.40 |
| Ralph | 4/10 | 4/10 | 1 | $30.70 | $3.07 |

**Validated across 3 consecutive runs: 45/45 benchmark tests passing each time.**

> ✓ **2× pass rate vs Ralph at 2.6× lower cost** — 10/10 vs 4/10 · $11.90 vs $30.70  
> ✓ **0 unsafe outcomes** — Ralph and Ralphy each produced 1. MartinLoop: 0.  
> ✓ **30–60% cost reduction** — Model Router + hard budget stops + delta re-prompting  

Reproduce it yourself:
```sh
git clone https://github.com/Keesan12/MartinLoop
cd MartinLoop
pnpm install
pnpm test            # 417 tests green
bun run benchmark    # Run the full comparative benchmark
```

Methodology: [`benchmarks/comparative/history/latest.md`](./benchmarks/comparative/history/latest.md)

---

## The 14-Class Adversarial Leash

> Every diff. Pre-execution. Before any subprocess runs.

| Code | Class | Severity | What it catches |
|------|-------|----------|-----------------|
| T01 | `OBJECTIVE_DRIFT` | 🔴 Critical | Agent wandering outside declared scope |
| T02 | `SCOPE_CREEP` | 🟠 High | Touching files outside the surface |
| T03 | `SHELL_PIPE_EVAL` | 🔴 Critical | `bash -c`, `eval`, pipe-to-shell patterns |
| T04 | `RM_RF_PATTERN` | 🔴 Critical | Recursive deletion attempts |
| T05 | `GIT_RESET_HARD` | 🟠 High | Force-resets that wipe history |
| T06 | `FORK_BOMB` | 🔴 Critical | Process multiplication patterns |
| T07 | `OBFUSCATED_EVAL` | 🔴 Critical | Base64/hex-encoded execution attempts |
| T08 | `NET_EXFIL_ATTEMPT` | 🟠 High | Unexpected outbound data transfers |
| T09 | `PRIV_ESC_PATTERN` | 🔴 Critical | sudo, chmod 777, setuid patterns |
| T10 | `FILE_QUOTA_BREACH` | 🟠 High | Writing beyond configured surface quota |
| T11 | `BUDGET_EXHAUSTION` | 🟠 High | Run approaching or at cost cap |
| T12 | `CLAIM_CONTRADICTION` | 🟡 Medium | Agent claiming success without evidence |
| T13 | `CVE_ADVISORY` | 🟠 High | Dependency changes with HIGH/CRITICAL CVEs |
| T14 | `AST_LOCK_VIOLATION` | 🟡 Medium | Structural changes violating declared invariants |

**63 / 63 adversarial gate checks passing. Zero false positives.**

Run it yourself: `pnpm eval:gate-check`

---

## Overnight Engineer: 10 Real Tasks, 10 Verified Completions

Queue work before bed. Read results in the morning.

| Task | Workflow | Morning Deliverable | Cost |
|------|----------|---------------------|-----:|
| Auth regression handoff | autoresearch | Handoff memo + failing edge isolated | $0.94 |
| Stabilize flaky CI gate | repair | Green CI + root-cause + patch artifact | $1.24 |
| Add regression test | test-addition | New regression coverage with proof | $0.66 |
| Recover typecheck regression | repair | Targeted fix with passing verifier | $1.08 |
| Resolve lockfile conflict | dependency-hygiene | Resolved with clean install notes | $0.74 |
| CLI tool path fallback | fallback | Fallback selected, command restored | $0.59 |
| Rollback canary verify | incident-response | Validation note with canary checks | $0.97 |
| Session-state regression | repair | Regression fixed with verifier evidence | $1.05 |
| Dead fixture cleanup | cleanup | Cleanup diff, no behavioral regression | $0.51 |
| Stale observability cache | observability | Fresh cache + summary of changes | $0.82 |

**10/10 verified completions across 3 deterministic reruns. Total cost: $8.60.**

[Full case study →](https://martinloop.com/case-study)

---

## Architecture

> The full governance stack — from policy to signed proof.

```
┌─────────────────────────────────────────────────┐
│              MartinLoop Governance Stack         │
├─────────────────┬───────────────────────────────┤
│  Autonomy       │  Surface · Path · Command      │
│  Envelope V2    │  Leash — pre-execution         │
├─────────────────┼───────────────────────────────┤
│  MCP Gateway    │  JSON-RPC 2.0 · OAuth vault    │
│                 │  Tool auditing + policy gate   │
├─────────────────┼───────────────────────────────┤
│  Model Router   │  6-priority heuristics         │
│                 │  Cost-aware · OTel telemetry   │
├─────────────────┼───────────────────────────────┤
│  Agent Engine   │  Claude · Codex · any CLI      │
│                 │  Adapters: direct + stub       │
├─────────────────┼───────────────────────────────┤
│  Leash Check    │  14 classes · re-validation    │
│                 │  before apply · 63/63 pass     │
├─────────────────┼───────────────────────────────┤
│  Audit Trail    │  Ed25519-signed · 9 OTel spans │
│                 │  Tamper-evident · offline-ok   │
└─────────────────┴───────────────────────────────┘
```

---

## OSS Core Packages

| Package | What It Does | Key Evidence |
|---------|-------------|-------------|
| `@martin/core` | Runtime controller, leash, router, rollback, memory palace | 12/12 safe task scenarios pass |
| `@martin/cli` | `martin run`, `explain`, `resume`, `audit`, `doctor` | Smoke-tested: `pnpm public:smoke` |
| `@martin/adapters` | Claude CLI, Codex CLI, direct-provider, stub adapters | E2E tested |
| `@martin/policy` | Compiled OPA Wasm policy loader + evaluator | `pnpm --filter @martin/policy test` |
| `@martin/audit-exporter` | Optional OTLP HTTP log exporter for ledger events | Build-verified |
| `@martin/mcp` | MCP server surface for Martin operations | JSON-RPC 2.0 validated |
| `@martin/contracts` | Shared types: loop, policy, leash, budget, rollback | TypeScript strict |

---

## Installation & Development

**Requirements:** Node 20+ · pnpm 8+

```sh
# Install dependencies
pnpm install

# Run the full test suite (417 tests)
pnpm test

# Type check all packages
pnpm typecheck

# Build all packages
pnpm build

# Run the adversarial gate eval
pnpm eval:gate-check

# Run the benchmark harness
bun run benchmark

# Lint
pnpm lint

# Public package smoke test (pack → install → import → CLI help)
pnpm public:smoke
```

---

## Contributing

We welcome contributions. Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) first.

- Branch from `main` — never commit directly to `main`
- Conventional commits: `feat:` · `fix:` · `chore:` · `docs:` · `refactor:` · `test:`
- New capabilities must include tests — the 417-test suite must stay green
- Run `pnpm lint && pnpm test` before opening a pull request

```sh
git checkout -b feat/your-feature
# make your changes
pnpm lint && pnpm test
git commit -m "feat: describe what you built"
git push -u origin feat/your-feature
# open a PR
```

Found a security issue? See [`SECURITY.md`](./SECURITY.md) — we run a self-service red-team harness with 5 published seed bundles and an active adversarial CI sweep.

---

## Roadmap

- [x] Phase 1: OSS Core — CLI, runtime, leash, audit trail
- [x] Phase 2: Autonomy Envelope V2 — surface, path, command restrictions
- [x] Phase 3: Benchmark credibility — 45/45 across 3 runs
- [x] Phase 4: SLSA Build Level 3 — signed provenance on every release
- [ ] Phase 5: Hosted control plane dashboard (beta)
- [ ] Phase 6: Multi-agent parallel governance
- [ ] Phase 7: MartinLoop360 — agent-to-agent commerce layer
- [ ] Phase 8: OPA/Rego full policy engine integration

[View full roadmap →](https://martinloop.com/roadmap) · [Request a feature →](https://github.com/Keesan12/MartinLoop/issues)

---

## License

MIT — see [LICENSE](./LICENSE) for details.

The OSS core runs entirely in your repo. No SaaS dependency. No data exfiltration surface. The trust moat is the open code.

---

<div align="center">

**MartinLoop** · [martinloop.com](https://martinloop.com)

[Website](https://martinloop.com) · [Demo](https://martinloop.com/demo) · [Benchmark](https://martinloop.com/benchmark) · [Case Study](https://martinloop.com/case-study) · [Docs](https://martinloop.com/docs)

*AI coding accountability: completes good work · refuses bad work · stops uneconomical work · leaves evidence behind.*

---

*Built by practitioners who hit this problem firsthand — then decided to fix it for everyone.*

</div>
