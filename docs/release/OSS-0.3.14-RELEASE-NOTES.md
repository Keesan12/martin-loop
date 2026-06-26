# MartinLoop 0.3.14 — VS Code / Claude Code / Codex IDE write fix

## Root cause

When MartinLoop runs inside Claude Code desktop, VS Code, or the Codex IDE,
`process.execPath` resolves to the host application's bundled Electron Node,
not the system Node on PATH. npm CLI shims (`.cmd`/`.ps1`) invoked with
Electron's Node fail because Electron uses a different module resolution path.
The result: `martin run` completes, reports success, and writes nothing to disk.

## Fix

`resolveSystemNode()` added to `packages/adapters/src/cli-bridge.ts`. On
Windows, when about to execute a resolved npm shim via `process.execPath`,
the function walks PATH entries looking for `node.exe`, skipping any path
that contains `electron`, `claude`, `vscode`, or `cursor` as a path segment.
The first match is used. If no system Node is found, falls back to
`process.execPath` (prior behavior).

Set `MARTIN_NODE_PATH=/absolute/path/to/node.exe` to bypass the PATH walk
(useful in CI or environments with a minimal PATH).

## Affected configurations

| Environment | Before | After |
|-------------|--------|-------|
| PowerShell (standalone) | ✓ works | ✓ unchanged |
| VS Code integrated terminal | ✗ writes nothing | ✓ writes files |
| Claude Code desktop agent panel | ✗ writes nothing | ✓ writes files |
| Codex IDE terminal | ✗ writes nothing | ✓ writes files |
| Linux / macOS (any terminal) | ✓ works | ✓ unchanged — win32-only code path |

## Upgrade

```sh
npm install -g martin-loop@0.3.14
```

No config changes required.
