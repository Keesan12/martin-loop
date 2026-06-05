# CLI Reference

The published binary is `martin-loop`. Public installs, docs, and examples should use `martin-loop`.

## Commands

```text
martin-loop start [--host <codex|claude|gemini|generic>]
martin-loop tour [--host <codex|claude|gemini|generic>]
martin-loop guide [topic]
martin-loop doctor
martin-loop demo
martin-loop session-start [--host <claude|codex|generic>]
martin-loop phase status|contract|preflight|run [--execute]
martin-loop preflight <objective> [options]
martin-loop run <objective> [options]
martin-loop triage
martin-loop dossier (--latest | --loop-id <id> | --file <path>)
martin-loop inspect --file <path>
martin-loop resume <loopId>
martin-loop runs list|get|attempt|verify ...
martin-loop mcp print-config --host <codex|claude|gemini|generic>
martin-loop mcp install --host <codex|claude|gemini|generic>
```

## Onboarding Flow

Use this sequence when you are new to the product or setting up a fresh repo:

```sh
npx martin-loop start
npx martin-loop tour
npx martin-loop doctor
npx martin-loop session-start
npx martin-loop preflight "Summarize the workspace and prove tests still pass" --verify "npm test"
npx martin-loop run "Summarize the workspace and prove tests still pass" --proof --verify "npm test"
```

## Run Options

```text
--objective <text>      The task to accomplish, or pass it as the first positional arg
--budget <n>            Hard cost cap in USD
--budget-usd <n>        Alias for --budget
--soft-limit-usd <n>    Soft budget threshold in USD
--verify <cmd>          Verifier command after each attempt
--proof                 Use the no-spend proof adapter instead of a live coding CLI
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
```

## Phase Commands

`session-start` and `phase` read local MartinLoop receipts and local phase state, then turn that state into a suggested run contract before work starts.

- `phase status` summarizes local posture.
- `phase contract` prints the generated contract.
- `phase preflight` prints the preflight invocation.
- `phase run` prints the governed run invocation.

`phase preflight` and `phase run` are dry-run by default. Add `--execute` only after the generated contract has the right verifier, budget, allowed paths, and blocked paths.
