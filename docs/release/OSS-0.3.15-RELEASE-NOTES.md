# MartinLoop 0.3.15 — martin mode, martin clean, preflight gate fix

## New commands

### martin mode

Show or set the working mode for governed runs.

```sh
martin mode               # print current mode
martin mode auto          # autonomous execution, no confirmation prompts (default)
martin mode plan          # show the execution plan before starting each run
martin mode edits         # show each file write before committing it to disk
```

Mode is stored in `~/.martin/config.json` and persists across sessions.
`martin start` now shows the current mode on its first output line and
recommends `martin mode auto` on first run.

### martin clean

Remove MartinLoop workflow artifacts from the current workspace.

```sh
martin clean              # delete _martin/ workflow state directory
martin clean --runs       # also delete run records older than 30 days
martin clean --all        # delete all run records regardless of age
```

## Fixes

### Preflight gate no longer rejects on objective wording differences

The gate's receipt-match key previously included an objective hash. Re-running
a task with slightly different wording (e.g., adding punctuation or rephrasing)
triggered a gate block even when the working directory and engine were the same.

Match key is now `workingDirectory + engine` only.

### Session-start receipt is optional when estimate receipt is present

`evaluateCliRunGate` previously required a session-start receipt unconditionally.
If an estimate receipt is present for the current working directory, session-start
is no longer a blocking requirement.

## Upgrade

```sh
npm install -g martin-loop@0.3.15
martin mode auto
```
