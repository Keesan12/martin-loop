# MartinLoop 0.4.5 — MartinLoop Arcade

`0.4.5` ships the MartinLoop Arcade: a terminal Space Invaders game that plays while a governed run works in the background.

## What changed

- MartinLoop Arcade launches automatically when a governed run has been running for 30 seconds in an interactive terminal
- The game prompts once: "Still working. Play MartinLoop Arcade while you wait? [y/N]" — default is No
- Accepting starts Space Invaders while the governed run continues uninterrupted in the background
- The game closes automatically when the run completes, and the real result, receipt, and exit code are preserved
- Terminal state (cursor, input mode, screen) is fully restored after the game exits under all conditions including errors and Ctrl+C
- `--arcade` flag starts or offers the game immediately without waiting for the 30-second threshold
- `--no-arcade` disables the prompt entirely for that run
- The prompt never appears in CI, piped output, JSON mode, or non-interactive agent execution — it is opt-in only

## Why it matters

Long governed runs can take several minutes. The arcade keeps the terminal useful without interrupting the run or compromising its receipts. The game is themed around MartinLoop's job: the player is the governance engine defending the budget from Token Spenders, CPU Hogs, API Callers, and Budget Drains.

## Upgrade / audit lane

```sh
npx -y martin-loop@0.4.5 --version
npx -y martin-loop@0.4.5 start
npx -y martin-loop@0.4.5 demo
cd martin-loop-demo
npm install
npx -y martin-loop@0.4.5 run "Summarize the demo workspace and prove tests still pass" --verify "npm test" --budget-usd 2 --max-iterations 1 --json
npx -y martin-loop@0.4.5 dossier --latest --json
npx -y martin-loop@0.4.5 share --latest --json
```

## Package lines in this release

- root package advances to `0.4.5`
- standalone `@martinloop/mcp` remains at `0.3.8` (no MCP server changes in this release)

See [VERSION-LEDGER.md](./VERSION-LEDGER.md) for the canonical version map.
