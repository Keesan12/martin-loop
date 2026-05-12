# Martin Loop

Governed runtime for AI coding agents with budgets, policy gates, rollback evidence, and auditable run records.

![Martin Loop CLI release surface](./docs/assets/marketing/github-readme-cli.svg)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/Keesan12/martin-loop/main/docs/assets/nvidia-inception-program.png" />
  <img src="https://raw.githubusercontent.com/Keesan12/martin-loop/main/docs/assets/nvidia-inception-program-light.png" alt="NVIDIA Inception Program logo" width="280" />
</picture>

Martin Loop has been accepted into the NVIDIA Inception program.

[![License](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![TypeScript](https://img.shields.io/badge/language-TypeScript-3178c6)](./tsconfig.base.json)
[![Node](https://img.shields.io/badge/node-%3E%3D20-green)](./package.json)

AI coding agents can write files, run commands, spend provider budget, and leave behind hard-to-review state. Martin Loop wraps those actions in a runtime that answers five questions before you trust the result:

- What is the task allowed to touch?
- What is the hard budget?
- Which safety and policy gates ran?
- Did the verifier actually execute?
- Where is the evidence if the result needs review, rollback, or resume?

Current public wording should describe Martin Loop as a **bounded governed AI-coding runtime**, not as a hands-off unrestricted production developer or broadly self-updating system. Trace-autonomy certification exists as a gate, but public trace-autonomy wording remains blocked until the signed evidence pack and external audit signoff pass.

## Release State

- Phase 14 staged pilot: closed
- Phase 15 public release: active
- Phase 15 adds release-specific truth, packaging, and final-gate checks on top of this baseline.

## Why It Exists

| Risk in agentic coding loops | Martin Loop control |
|---|---|
| Retry loops can spend without a hard stop | Budget admission checks, soft limits, hard USD caps, iteration caps, and token caps |
| Agents can mutate the wrong surface | Task contracts, allowed paths, denied paths, policy leashes, and rollback evidence |
| "Verifier passed" can hide that no verifier ran | Verifier lifecycle state, failure taxonomy, and machine-readable exit reasons |
| Failure evidence is easy to lose | Canonical run records, ledger events, receipts, and handoff artifacts |
| Operators need proof before widening claims | Claim linting, release gates, audit packs, and signed autonomy certification artifacts |

Martin Loop does not replace Claude, Codex, or other coding agents. It gives those agents an operating envelope.

![Martin Loop architecture](./docs/assets/architecture.svg)

## What It Does Today

| Capability | Current behavior |
|---|---|
| Budget governance | Enforces `maxUsd`, `softLimitUsd`, `maxIterations`, and `maxTokens`; rejects attempts projected to exceed remaining budget. |
| Safety leash | Blocks unsafe verifier commands, out-of-scope writes, secret-like task text, and policy-restricted surfaces before accepting work. |
| Adapter execution | Normalizes Claude CLI, Codex CLI, direct-provider, and stub execution into one runtime result contract. |
| Verification gate | A run reaches `completed` only when adapter execution and verifier state both support the result. |
| Rollback evidence | Captures rollback boundaries and restore outcomes for repo-backed attempts when persistence is configured. |
| Trace intelligence | Reads run ledgers and reports loop patterns such as recovery exhaustion, verifier blind spots, oscillation, and budget pressure. |
| Guarded improvement | Emits improvement evidence and promotion artifacts; trusted-surface promotion remains policy-gated and claim-safe. |
| MCP package | Provides a standalone `@martinloop/mcp` server with `martin_run`, `martin_inspect`, and `martin_status`. |

## Quick Start

Install the public package:

```bash
npm install martin-loop
npx martin-loop --help
```

Run a provider-free stub loop first:

```bash
MARTIN_LIVE=false MARTIN_NO_BRIEF=1 npx martin-loop run --objective "Summarize this repository" --yes
```

Run a governed task with budget and verifier controls:

```bash
npx martin-loop run \
  --objective "Fix the auth regression" \
  --budget 3.00 \
  --verify "pnpm test" \
  --allow-path "src/**" \
  --deny-path ".env*"
```

Inspect a persisted run record:

```bash
npx martin-loop inspect --file ~/.martin/runs/<workspaceId>.jsonl
```

## MCP Server

Use the standalone MCP package when an MCP host needs to invoke Martin Loop:

```bash
npx @martinloop/mcp
```

Claude Code examples:

```bash
claude mcp add --scope user martin-loop -- npx @martinloop/mcp
```

Windows PowerShell or cmd:

```powershell
claude mcp add --scope user martin-loop cmd /c "npx @martinloop/mcp"
```

The standalone MCP package is intentionally narrow. It exposes:

- `martin_run`
- `martin_inspect`
- `martin_status`

Official registry publication is a guarded release step. The local package gate is:

```bash
pnpm --filter @martinloop/mcp test
pnpm --filter @martinloop/mcp build
pnpm --filter @martinloop/mcp smoke:pack
pnpm --filter @martinloop/mcp smoke:published
```

## Public Package Surface

Frozen public install targets:

- Install: `npm install martin-loop`
- CLI: `npx martin-loop`
- SDK: `import { MartinLoop } from "martin-loop"`
- MCP: `npx @martinloop/mcp`

The root package facade vendors the runtime, adapters, CLI, SDK, contracts, policy, audit exporter, and HeadlessOS core into `dist/`. Internal workspace package names such as `@martin/core` and `@martin/adapters` are implementation details unless separately published.

## TypeScript SDK

```typescript
import {
  MartinLoop,
  createClaudeCliAdapter,
  createCodexCliAdapter,
  runMartin
} from "martin-loop";

const loop = new MartinLoop({
  adapter: createClaudeCliAdapter({ workingDirectory: process.cwd() }),
  defaults: {
    workspaceId: "my-workspace",
    projectId: "my-project",
    budget: {
      maxUsd: 3.00,
      softLimitUsd: 2.25,
      maxIterations: 3,
      maxTokens: 20000
    }
  }
});

const result = await loop.run({
  task: {
    title: "Fix auth regression",
    objective: "Fix the failing auth regression tests",
    verificationPlan: ["pnpm test"],
    repoRoot: process.cwd()
  }
});

console.log(result.decision.status);
```

Use Codex instead of Claude by swapping adapters:

```typescript
const loop = new MartinLoop({
  adapter: createCodexCliAdapter({ workingDirectory: process.cwd() })
});
```

`runMartin` is also exported for callers that want to assemble runtime input directly.

## CLI Reference

```text
martin-loop run <objective> [options]

  --objective <text>      Task to accomplish, or pass it as the first positional arg
  --budget <n>            Hard cost cap in USD
  --budget-usd <n>        Alias for --budget
  --soft-limit-usd <n>    Soft budget threshold in USD
  --verify <cmd>          Verifier command after each attempt
  --max-iterations <n>    Maximum number of attempts
  --max-tokens <n>        Maximum total token budget
  --engine <name>         Adapter to use: claude or codex
  --model <name>          Adapter model override
  --cwd <path>            Repo root for the run
  --allow-path <glob>     Restrict agent writes to this path pattern; repeatable
  --deny-path <glob>      Block this path pattern; repeatable
  --accept <criterion>    Acceptance criterion; repeatable
  --config <path>         Path to martin.config.yaml
  --workspace <id>        Workspace ID for the run record
  --project <id>          Project ID for the run record
  --metadata <key=value>  Attach metadata to the run record; repeatable
```

The public CLI also includes `inspect`, `resume`, and a `bench` redirect that points reviewers to the workspace benchmark harness.

## Configuration

Drop a `martin.config.yaml` in the repo root to set governance defaults:

```yaml
budget:
  maxUsd: 5.00
  softLimitUsd: 3.75
  maxIterations: 5
  maxTokens: 40000

governance:
  destructiveActionPolicy: approval
  telemetryDestination: local-only
  verifierRules:
    - pnpm test
```

CLI flags override config values when provided.

## Claim Boundaries

Martin Loop has implemented guarded learning, signed promotion artifacts, trace-autonomy certification tooling, and fail-closed claim gates. That is not the same as an unrestricted self-modifying production system.

Do not use unqualified public wording for full hands-off operation, unrestricted system writes, any-part self-updates, fully self-learning behavior, or improvement claims without scope and evidence qualifiers.

The bounded future trace-intelligence claim is allowed only after the trace-autonomy certification gate, signed bundle, required live evidence, and external audit signoff pass.

## Development

Requirements:

- Node 20+
- pnpm 10.x

```bash
git clone https://github.com/Keesan12/martin-loop.git
cd martin-loop
pnpm install
pnpm build
pnpm test
pnpm lint
```

Release and claim gates:

```bash
pnpm oss:validate
pnpm release:surface:validate
pnpm public:smoke
pnpm mcp:published:smoke
pnpm repo:smoke
pnpm rc:validate
pnpm pilot:prep:validate
pnpm claims:lint
pnpm release:gate:review
pnpm release:matrix:local
```

Useful evidence docs:

- [OSS quickstart](./docs/oss/QUICKSTART.md)
- [OSS examples](./docs/oss/EXAMPLES.md)
- [OSS boundary report](./docs/oss/OSS-BOUNDARY-REPORT.md)
- [Release surface report](./docs/oss/RELEASE-SURFACE-REPORT.md)
- [Release gate review](./docs/release/RELEASE-GATE-REVIEW.md)
- [Phase 3 autonomy handoff](./docs/handoffs/2026-05-07-phase3-autonomy-implementation-handoff.md)

## Workspace Map

| Package or app | Role |
|---|---|
| `martin-loop` | Root public npm facade that vendors the runtime, CLI, adapters, SDK, contracts, and policy into `dist/`. |
| `@martin/core` | Runtime controller, policy engine, safety leash, grounding, persistence, rollback, and autonomy primitives. |
| `@martin/adapters` | Claude CLI, Codex CLI, direct-provider, and stub adapter surfaces. |
| `@martin/cli` | Local CLI implementation for `run`, `inspect`, `resume`, `verify`, `audit`, `doctor`, `explain`, and improvement flows. |
| `@martin/trace-intelligence` | Run-ledger analysis, trace pattern detection, improvement tasks, and trace-autonomy certification. |
| `@martinloop/mcp` | Standalone MCP server package for `martin_run`, `martin_inspect`, and `martin_status`. |
| `apps/control-plane` | Hosted/operator control-plane workstream, outside the initial npm package surface. |
| `apps/local-dashboard` | Local read-model viewer, not currently packaged as public npm API. |
| `benchmarks` | Workspace-only deterministic benchmark and RC validation harness. |

## Contributing

```bash
git checkout -b feat/your-feature
pnpm lint
pnpm test
git commit -m "feat: describe what you built"
git push -u origin feat/your-feature
```

Use conventional commit prefixes such as `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, and `chore:`.

## License

MIT. See [LICENSE](./LICENSE).
