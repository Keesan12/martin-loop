# OSS install funnel

Primary conversion path:

1. Discover MartinLoop in an MCP/plugin/agent directory.
2. Install with one command.
3. Run the guided start path.
4. Complete a real governed run.
5. Generate a dossier/share receipt.

## CLI

```sh
npx -y martin-loop@latest start
```

## MCP

```sh
npx -y @martinloop/mcp@latest
```

## First run

```sh
npx -y martin-loop@latest demo
cd martin-loop-demo
npm install
npx -y martin-loop@latest run "Summarize the demo workspace and prove tests still pass" --verify "npm test" --budget-usd 2 --max-iterations 1
```

Distribution placements should prefer an install command over a homepage link when the directory format allows it.
