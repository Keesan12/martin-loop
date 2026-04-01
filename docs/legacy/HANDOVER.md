# Martin Loop — CTO / Engineer Handover

Pre-GitHub review document. Covers what was built, what was tested, known limitations, and what to verify before publishing.

---

## What was built (this sprint)

The monorepo already had a complete orchestration engine (`@martin/core`) and governance layer, but **all adapters were stubs**. This sprint wired up real adapters and the MCP server:

### 1. `@martin/adapters` — Real CLI subprocess adapters

**File:** `packages/adapters/src/claude-cli.ts`

- `createClaudeCliAdapter()` — spawns `claude --print "<prompt>" --dangerously-skip-permissions [--model X]`
- `createCodexCliAdapter()` — spawns `codex [--full-auto] [--model X] "<prompt>"`
- `createAgentCliAdapter()` — generic factory for any CLI tool (argsBuilder pattern)
- Prompt builder: formats objective, verification plan, constraints, and prior failed attempts into a structured prompt the CLI agents understand
- Verification runner: executes each verification command sequentially after the agent finishes
- Timeout handling: kills subprocess via SIGTERM after configurable `timeoutMs` (default 5 min)
- Failure signals embedded in `failure.message`: `"stalled"`, `"environment_mismatch"` — picked up by `classifyFailure()` in core

**Guard:** `MARTIN_LIVE=false` env var → uses stub adapter. All CI tests run with this guard.

### 2. `@martin/cli` — `--engine` and `--cwd` flags wired

**File:** `packages/cli/src/index.ts` — `selectAdapter()` function

- `--engine claude` (default) → `createClaudeCliAdapter`
- `--engine codex` → `createCodexCliAdapter`
- `--cwd <path>` → sets `workingDirectory` on the adapter (where the agent runs)
- `MARTIN_LIVE=false` → stub adapter regardless of engine flag

### 3. `@martin/mcp` — MCP Server (new package)

**Files:** `packages/mcp/src/server.ts` + `src/tools/`

Three MCP tools exposed over stdio transport:
- `martin_run` — calls `runMartin()` with a real or stub adapter
- `martin_inspect` — reads a loop record JSON file, returns portfolio snapshot
- `martin_status` — evaluates cost governor state from a loop record

Registration: `claude mcp add martin-loop -- npx @martin/mcp`

### 4. Benchmarks / Eval harness

**File:** `benchmarks/src/eval.ts`

- 3 fixture tasks in `benchmarks/fixtures/eval-tasks.json`
- Runs each task in an isolated temp directory
- Reports solve rate, avg attempts, total cost
- Exit code 1 if solve rate < 60%
- Command: `pnpm eval` (requires live claude)

---

## E2E test results (run 2026-03-30)

### CLI — stub mode
```
$ MARTIN_LIVE=false martin run --objective "hello world" --max-iterations 1 --budget-usd 2
{
  "command": "run",
  "decision": { "lifecycleState": "budget_exit", "status": "exited" },
  "loop": { "loopId": "loop_0mwd5gio", "status": "exited", "attempts": [...] }
}
```
Result: PASS — loop ran, stub returned, budget_exit after 1 iteration as expected.

### CLI — live mode (real Claude)
```
$ martin run \
    --objective "Create a file called hello.txt containing the text 'Hello from Martin'" \
    --cwd /tmp/martin-live-test \
    --max-iterations 1 --budget-usd 2
```
Result:
- `status: exited` (budget_exit after 1 iteration)
- `attempts: 1` — Claude ran
- `hello.txt` written with content `"Hello from Martin"` — **Claude actually executed the task**
- `costUsd: 0` — expected; CLI adapters don't expose token counts (honest zero, not a billing bug)

### MCP tools — direct invocation
```
martin_status:  { pressure: "healthy", shouldStop: false, remainingBudgetUsd: 7 }  PASS
martin_inspect: { loopCount: 1, totalActualUsd: 3 }                                PASS
martin_run:     { status: "exited", loopId: true, attempts: 1 }                    PASS
```

### Full test suite
```
pnpm test
89 tests across 7 packages — 0 failures
pnpm build — clean
pnpm lint  — clean
```

---

## Known limitations / honest notes

### Cost tracking is zero for CLI adapters
The `claude --print` and `codex` CLIs do not expose token usage or cost in their stdout. The adapter always returns `{ actualUsd: 0, tokensIn: 0, tokensOut: 0 }`. This means:
- Budget governor operates on **iteration count**, not actual dollar spend, for CLI adapters
- Cost tracking is only accurate with direct-provider adapters (API key path)
- This is by design and documented — not a bug

### Codex not tested live
`@openai/codex` was not installed in the test environment. The adapter code is identical in structure to the Claude adapter and has been unit-tested. Live testing requires: `npm install -g @openai/codex` + `OPENAI_API_KEY` set.

### MCP server is stdio-only
The MCP server uses stdio transport (not HTTP). This is the correct pattern for Claude Desktop / Claude Code MCP integration, but means it cannot be tested with curl. Test it via `claude mcp add` or by importing the tool functions directly (as done in `packages/mcp/tests/`).

### `softLimitUsd` default may be set higher than `maxUsd`
When `--budget-usd 2` is passed without `--soft-limit-usd`, the default `softLimitUsd: 15` is higher than the `maxUsd: 2`. This won't cause a crash (hard limit still applies) but the soft-limit pressure signal won't fire. In production use, always set both together or use a config file.

---

## Files changed this sprint

```
packages/adapters/src/claude-cli.ts          NEW — real CLI adapters
packages/adapters/src/stub-direct-provider.ts MODIFIED — removed invalid classHint field
packages/adapters/src/index.ts               MODIFIED — exports claude-cli factories
packages/adapters/tsconfig.json              MODIFIED — points @martin/core → src/index.ts
packages/adapters/tests/claude-cli.test.ts   NEW — 14 tests for CLI adapters

packages/cli/src/index.ts                    MODIFIED — selectAdapter(), inspect error handling
packages/cli/tests/cli-integration.test.ts   NEW — 8 integration tests
packages/cli/tests/cli.test.ts               MODIFIED — MARTIN_LIVE=false guards added
packages/cli/package.json                    MODIFIED — removed private, added publishConfig

packages/mcp/package.json                    NEW
packages/mcp/tsconfig.json                   NEW
packages/mcp/tsconfig.build.json             NEW
packages/mcp/vitest.config.ts                NEW
packages/mcp/src/server.ts                   NEW — MCP server with 3 tools
packages/mcp/src/tools/run-loop.ts           NEW
packages/mcp/src/tools/inspect-loop.ts       NEW
packages/mcp/src/tools/get-status.ts         NEW
packages/mcp/tests/mcp-tools.test.ts         NEW — 11 tests

benchmarks/src/eval.ts                       NEW — live eval harness
benchmarks/fixtures/eval-tasks.json          NEW — 3 eval tasks
benchmarks/package.json                      MODIFIED — eval script, deps

README.md                                    UPDATED
HANDOVER.md                                  NEW (this file)
```

---

## Pre-publish checklist

- [ ] Confirm `@martin/*` npm scope ownership (npmjs.com)
- [ ] Add `LICENSE` file (MIT recommended)
- [ ] Verify `OPENAI_API_KEY` / codex flow with `@openai/codex` installed
- [ ] Run `pnpm eval` with live claude against all 3 fixture tasks
- [ ] Review `apps/control-plane` — currently `private: true`, decide if publishing
- [ ] Set GitHub repo to public, add topics: `ai-agents`, `coding-loops`, `claude`, `codex`, `mcp`
- [ ] Add `.npmrc` with `//registry.npmjs.org/:_authToken=${NPM_TOKEN}` for CI publishing
- [ ] Add GitHub Actions workflow for `pnpm test && pnpm build` on PRs

---

## How to verify locally before publish

```bash
# 1. Clean install + build
pnpm install && pnpm build

# 2. All tests pass
pnpm test

# 3. Lint clean
pnpm lint

# 4. Stub dry run
MARTIN_LIVE=false node packages/cli/dist/bin/martin.js run \
  --objective "test task" --max-iterations 1 --budget-usd 2

# 5. Live test with Claude (requires claude auth login)
node packages/cli/dist/bin/martin.js run \
  --objective "Create a file called result.txt containing the word 'done'" \
  --cwd /tmp/martin-verify \
  --max-iterations 1 --budget-usd 3

# 6. MCP server starts clean
node packages/mcp/dist/server.js &
# Should block waiting on stdin with no errors
```
