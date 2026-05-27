# CLI Reference

## Commands

```text
martin-loop doctor
martin-loop demo
martin-loop run <objective> [options]
martin-loop triage
martin-loop dossier (--latest | --loop-id <id> | --file <path>)
martin-loop inspect --file <path>
martin-loop resume <loopId>
martin-loop mcp print-config --host <codex|claude|gemini|generic>
martin-loop mcp install --host <codex|claude|gemini|generic>
```

## Run Options

```text
--objective <text>      The task to accomplish, or pass it as the first positional arg
--budget <n>            Hard cost cap in USD
--budget-usd <n>        Alias for --budget
--soft-limit-usd <n>    Soft budget threshold in USD
--verify <cmd>          Verifier command after each attempt
--max-iterations <n>    Maximum number of attempts
--max-tokens <n>        Maximum token budget
--engine <name>         Adapter to use: claude or codex
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
