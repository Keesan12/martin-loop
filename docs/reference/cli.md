# CLI Reference

The published binary is `martin-loop`. Public installs, docs, and examples should use `martin-loop`.

## Commands

```text
martin-loop --version
martin-loop start
martin-loop tour
martin-loop doctor
martin-loop demo
martin-loop session-start [--host <claude|codex|gemini|generic>]
martin-loop phase status|contract|session-start|preflight|run [--execute]
martin-loop preflight <objective> [options]
martin-loop run <objective> [options]
martin-loop bench --suite <suiteId>
martin-loop triage
martin-loop dossier (--latest | --loop-id <id> | --file <path>)
martin-loop inspect --file <path>
martin-loop resume <loopId>
martin-loop challenge [--loop-id <id> | --file <path> | --latest] [--format markdown|svg]
martin-loop share (--loop-id <id> | --file <path> | --latest) [--out-dir <path>]
martin-loop badge [--format svg|json] [--runs-dir <path>]
martin-loop runs list|get|attempt|verify ...
martin-loop mcp print-config --host <codex|claude|gemini|cursor|copilot|continue|generic>
martin-loop mcp install --host <codex|claude|gemini|cursor|copilot|continue|generic>
```

## MCP Installer

The native installer supports Codex, Claude Code, Gemini CLI, Cursor, VS Code / GitHub Copilot (`copilot`), Continue, and generic MCP hosts.

```text
--scope <user|project|local>  user or project for every host; local is Claude-only
--profile <name>              minimal, diagnostic, github-review, full-local, paid-remote, starter, or full
--transport <stdio|remote>    stdio by default
--dry-run                     preview the target and generated config without writing
```

Every preview includes the config target, enabled tools, and governance guidance. See the [MCP setup guide](../getting-started/mcp.md) for the authoritative host-to-file matrix and safe install behavior.

## Onboarding Flow

Use this sequence when you are new to the product or setting up a fresh repo:

```sh
npx -y martin-loop@latest start
npx -y martin-loop@latest --version
npx -y martin-loop@latest demo
cd martin-loop-demo
npm install
npx -y martin-loop@latest run "Summarize the workspace and prove tests still pass" --verify "npm test" --budget-usd 2 --max-iterations 1
npx -y martin-loop@latest share --latest
```

`run` auto-checks `doctor`, `session-start`, and `preflight`, then executes when the environment is ready. Run those commands directly when you want to inspect the governed checks first.

## Run Options

```text
--objective <text>      The task to accomplish, or pass it as the first positional arg
--budget <n>            Hard cost cap in USD
--budget-usd <n>        Alias for --budget
--soft-limit-usd <n>    Soft budget threshold in USD
--verify <cmd>          Verifier command after each attempt
--proof                 Explicitly opt into a no-spend proof adapter lane
--verify-only           Explicitly skip the coding adapter and run verifier-only
--unsafe-allow-unguarded-run
                        Bypass the local governance gate for this one run
--max-iterations <n>    Maximum number of attempts
--max-tokens <n>        Maximum token budget
--engine <name>         Adapter to use: claude, codex, or openai
--model <name>          Override the adapter model
--cwd <path>            Repo root for the run
--allow-path <glob>     Restrict writes to this path pattern; repeatable
--deny-path <glob>      Block this path pattern; repeatable
--accept <criterion>    Add an acceptance criterion; repeatable
--config <path>         Path to a martin.config.yaml file
--workspace <id>        Workspace ID for the run record
--project <id>          Project ID for the run record
--metadata <key=value>  Attach metadata to the run record; repeatable
```

## Inspect-First Flow

```sh
npx -y martin-loop@latest doctor
npx -y martin-loop@latest session-start
npx -y martin-loop@latest preflight "fix the auth regression" --verify "pnpm test"
```

## Benchmark Reproduction

Use `bench` when you want the shipped public benchmark summary from an installed package:

```sh
npx martin-loop bench --suite under-3-challenge
npx martin-loop bench --suite ralphy-engineering-50
```

Use the public benchmark workspace when you want clean-clone repro from the repository:

```sh
pnpm install --frozen-lockfile
pnpm --filter @martin/benchmarks build
pnpm --filter @martin/benchmarks test
pnpm --filter @martin/benchmarks eval
pnpm --filter @martin/benchmarks report:ralphy
```

## Shared persisted-run options

```text
--runs-dir <path>       Override the Martin runs root for guided flow receipts, persisted evidence views, and badge generation
--out-dir <path>        Override where `martin share` writes the local share bundle
```

## Evidence Commands

Use `triage` first when you want the fastest ranking of saved runs:

```sh
npx martin-loop triage
```

Use `dossier` when you want one run receipt:

```sh
npx martin-loop dossier --latest
```

Compatibility views remain available:

```sh
npx martin-loop inspect --file ~/.martin/runs/<workspaceId>.jsonl
npx martin-loop resume <loopId>
npx martin-loop challenge --latest
npx martin-loop share --latest
npx martin-loop badge --format json --runs-dir ~/.martin/runs
```

## Share command

Use `share` when you want a reviewable bundle for the latest governed run or a specific saved run.

```sh
npx martin-loop share --latest
npx martin-loop share --loop-id <loopId>
npx martin-loop share --file ~/.martin/runs/<loopId>/loop-record.json
npx martin-loop share --latest --out-dir ./receipts
```

By default MartinLoop writes:

- `run-receipt.json`
- `run-receipt.md`

Proof-card images are optional:

- `--with-proof-card`
- `--proof-card-format svg|png|both`
- revision-safe image filenames such as `proof-card-r1-1a2b3c4d.svg`

The default output location is the selected run directory under `share/`.

## Phase Commands

`session-start` and `phase` read local MartinLoop receipts and local phase state, then turn that state into a suggested run contract before work starts.

- `phase status` summarizes local posture.
- `phase contract` prints the generated contract.
- `phase preflight` prints the preflight invocation.
- `phase run` prints the governed run invocation.

`phase preflight` and `phase run` are dry-run by default. Add `--execute` only after the generated contract has the right verifier, budget, allowed paths, and blocked paths.
