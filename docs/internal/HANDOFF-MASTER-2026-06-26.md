# MartinLoop Master Handoff — 2026-06-26

## FRESH SESSION PROMPT (copy this to start)

```
You are continuing work on MartinLoop, a governed AI coding agent platform.
Read this file first: docs/internal/HANDOFF-MASTER-2026-06-26.md in ML_Core_OSS_Internal.

Before ANY code changes:
1. npx martin-loop doctor --quiet
2. npx martin-loop estimate "<your task>" --budget-usd 5
3. npx martin-loop gate  ← must PASS before touching code

Repo: C:\Users\Torram\OneDrive\Documents\Codex Main\Setup Stuff\ML_Core_OSS_Internal
```

---

## What MartinLoop is

Governed AI coding agent platform. Gives every AI coding run:
- Hard budget caps (stops runaway spend)
- Verifier gates (tests must pass before completion)
- Pre-run cost estimates (know cost before spending)
- Receipts and proof cards (auditable evidence)
- Model-agnostic (Claude, Codex, Gemini, DeepSeek, Qwen, Llama, etc.)

---

## Live npm packages

| Package | Version | Published |
|---------|---------|-----------|
| martin-loop | 0.3.15 | ✓ live |
| @martinloop/mcp | 0.3.5 | ✓ live |

GitHub releases: https://github.com/Keesan12/martin-loop/releases

---

## Repository map

```
ML_Core_OSS_Internal/         ← primary OSS repo (this one)
  packages/
    contracts/                 ← TypeScript types, FailureClass enum
    core/                      ← runMartin(), classifyRoute(), memory/trace stores
    adapters/                  ← Claude/Codex/Gemini/OpenAI adapter implementations
    cli/                       ← martin-loop CLI (index.ts is 4000+ lines)
    mcp/                       ← @martinloop/mcp MCP server

ML_Engine_Internal/            ← private engine packages (11 packages)
  packages/
    headlessos-core/           ← context ingestion
    routing-control/           ← enterprise policy enforcement
    workflow-engine/           ← GSD rebrand (martin plan/execute)
    trace-intelligence/        ← run trace analysis
    formal-proof/              ← governance invariant proofs
    red-team/, fuzzer/, sdk/   ← security/testing

ML_Control_Plane_Internal/     ← Next.js control plane dashboard (NOT yet wired)
ML_Main_Repo_Internal/         ← full private monorepo (source of truth)
martin-loop_public/            ← public fork (Keesan12/martin-loop)
```

---

## What was built (last 3 days)

### 0.3.12 — Hard governance enforcement
- `martin estimate` writes receipt to workflow-state.json
- `martin gate` requires doctor + estimate receipts (exits 1 if missing)
- `martin mcp install --host claude` auto-installs PreToolUse hooks
- MCP `martin_run` blocks until estimate receipt exists

### 0.3.13 — Autonomous model + Windows fix
- `martin run` auto-selects model tier (haiku/sonnet/opus) by task complexity
- `resolveModelForTier(tier, engine)` — 7 engine families
- Windows npm-shim bypass (`createSpawnPlan` in cli-bridge.ts)
- `sandbox_write_blocked` failure class
- MartinLoop memory store (`_martin/memory.jsonl`, append-only)
- `martin://agent/memory-summary` MCP resource
- 28 new real tests

### 0.3.14 — IDE subprocess fix
- `resolveSystemNode()` skips Electron's bundled Node
- Detects "electron", "claude", "vscode", "cursor" in node path
- `MARTIN_NODE_PATH` env override for CI
- Fixes: Claude Code desktop, VS Code, Codex IDE (was PowerShell-only)

### 0.3.15 — Automode + preflight fix
- `martin mode auto|plan|edits` — new command, stored in ~/.martin/config.json
- `martin clean` — removes `_martin/` and old run records
- Preflight gate relaxed: workingDirectory+engine only (not objective hash)
- Session-start optional when estimate receipt present
- `martin start` shows mode recommendation on first line

---

## Architecture: governance flow

```
martin doctor         → writes cli.doctor receipt
martin estimate "..." → writes cli.estimate receipt (REQUIRED before run)
martin gate           → reads both, exits 1 if missing (used in Claude hooks)
martin preflight "..."→ writes cli.preflight receipt
martin run "..."      → evaluateCliRunGate() checks all receipts → runs
martin dossier        → shows receipt + what was prevented
```

MCP flow (via IDE):
```
martin_doctor → martin_estimate → martin_plan → martin_preflight → martin_run → martin_dossier
```

---

## Key files

| File | Purpose |
|------|---------|
| `packages/cli/src/index.ts` | All CLI commands (4000+ lines) |
| `packages/cli/src/workflow-state.ts` | Receipt tracking, gate evaluation |
| `packages/adapters/src/claude-cli.ts` | Claude/Codex/Gemini adapters + streaming inspector |
| `packages/adapters/src/cli-bridge.ts` | Subprocess spawning, Windows shim fix |
| `packages/core/src/routing.ts` | classifyRoute(), resolveModelForTier(), selectBestEngine() |
| `packages/core/src/persistence/memory-store.ts` | Append-only memory (never overwrites) |
| `packages/core/src/persistence/trace-store.ts` | Append-only run history |
| `packages/core/src/test-integrity.ts` | Circular test detection |
| `packages/core/src/repo-analyzer.ts` | Repo style detection → prompt directives |
| `packages/mcp/src/server.ts` | MCP server tools including martin_estimate |
| `packages/mcp/src/resources.ts` | MCP resources (governance-status, memory-summary) |
| `packages/cli/src/mcp-config.ts` | MCP install config, governance hooks, auto-install |

---

## GSD Roadmap (.planning/ROADMAP.md)

### Done (Phase 1): Auto-governance
All shipped in 0.3.11-0.3.15.

### Phase 3 (Partially done): Memory + autonomy
- ✓ Memory store (append-only)
- ✓ Trace store (append-only)
- ✓ Repo analyzer
- ✓ Autonomous model selection
- ✗ Plan 4: Consent prompting partially done (start reads memory but doesn't prompt)
- ✗ Plan 5: Tests for Wave 2 autonomy features

### NOT YET BUILT:
1. **Dashboard** (`ML_Control_Plane_Internal`) — Next.js app exists but not wired to real API
2. **MCP HTTP transport** — stdio only; cloud/JetBrains/Jupyter can't connect
3. **GSD → martin plan/execute** — `@martin/workflow-engine` built but CLI not wired
4. **`martin://agent/mode-status`** MCP resource
5. **Periodic mode check** in martin dossier
6. **Mode in estimate output** (show mode recommendation per route)
7. **ML_Engine_Internal routing tests** — need integration smoke test

---

## Known issues / user reports

1. **FIXED 0.3.14**: Not working in Claude Code desktop / Codex IDE (was PowerShell-only) → Electron Node bypass
2. **FIXED 0.3.15**: Preflight gate blocking even after preflight ran → relaxed hash match
3. **FIXED 0.3.15**: No automode control → `martin mode` command added
4. **Local artifacts on user machines** — `martin clean` added but users need to know about it
5. **Codex demo budget cap** (Gobi's report) — cap exceeds because budget kicks in after estimate but streaming inspector may still have edge cases

---

## Test counts (all passing)

- CLI: 221 tests across 17 files
- Core: 47 tests (routing, memory, trace, test-integrity, repo-analyzer)
- MCP: 14 baseline tests
- Contracts: 25 tests
- Adapters: 11 tests
- Integration scripts: taxonomy, mcp-release-docs, readme-surface

---

## How to run governed work (the RIGHT way)

```sh
# 1. Confirm environment
npx martin-loop doctor --quiet

# 2. ESTIMATE BEFORE ANY WORK (shows to user, wait for approval)
npx martin-loop estimate "<objective>" --engine claude --budget-usd 5

# 3. Confirm gate passes
npx martin-loop gate

# 4. Do the work

# 5. After work: get receipt
npx martin-loop dossier --latest
```

---

## Publish workflow

```sh
# Bump version in package.json + dist/vendor/cli/package.json + README.md
# Run: pnpm build && pnpm test
# Commit + git tag vX.X.X + git push origin main + git push origin vX.X.X
# npm publish --access public
# gh release create vX.X.X --repo Keesan12/martin-loop --latest --title "..."
# git push public main
```

npm auth: `npm set //registry.npmjs.org/:_authToken=<token>` (rotate after use!)

---

## What to tackle next (priority order)

### P1 — Complete what users are hitting
1. **Codex budget cap** — streaming inspector may still over-run on large repos
2. **Dashboard wiring** (ML_Control_Plane_Internal) — design partner pilots need it
3. **MCP HTTP transport** — enables cloud/JetBrains/Jupyter

### P2 — Product completeness
4. **`martin://agent/mode-status`** MCP resource
5. **Mode in estimate output** (automode recommended / plan mode required)
6. **Consent prompting** in `martin start` (ask for budget if not set)

### P3 — Enterprise
7. **GSD → `martin plan` + `martin execute`** CLI commands (workflow-engine built, just needs wiring)
8. **Trace intelligence aggregation** feeding classifyRoute() with real historical data
