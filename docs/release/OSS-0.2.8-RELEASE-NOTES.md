# martin-loop 0.2.8

MartinLoop `0.2.8` makes first-run setup clearer and adds a stronger default local gate before a governed run begins.

## Highlights

- Guided onboarding now lives in the CLI through `demo`, `doctor`, `session-start`, and the guarded `preflight` flow.
- Governed runs are hard-gated by default. MartinLoop expects recent `doctor`, local session, and `preflight` receipts before `run` will execute real work.
- MCP hosts get clearer built-in workflow guidance through updated resources, prompts, and tool descriptions.
- Docs and package READMEs now explain the same local-first command-center flow.

## Start Here

```sh
npx martin-loop demo
cd martin-loop-demo
npx martin-loop doctor
npx martin-loop session-start
npx martin-loop preflight "Summarize the demo workspace and prove tests still pass" --verify "npm test"
```

Then run the no-spend proof path:

```sh
npx martin-loop run "Summarize the demo workspace and prove tests still pass" --proof --verify "npm test"
npx martin-loop dossier --latest
```

## Upgrade Notes

- `npx martin-loop run` now blocks until the required local governance receipts exist for the same repo and task.
- `--unsafe-allow-unguarded-run` is available for advanced local operators who intentionally need to bypass the gate.
- `npx martin-loop demo` plus `doctor` and `session-start` is the recommended first-run path for onboarding a human or showing the product flow to an agent host operator.

## Validation

`0.2.8` is intended to pass the local public release gates:

- `pnpm install --frozen-lockfile`
- `pnpm lint`
- `pnpm test`
- `pnpm build`
- `pnpm public:copy-scan`
- `pnpm public:git-surface`
- `pnpm oss:validate`
- `pnpm public:smoke`
- `pnpm release:validate-local`
- `pnpm release:validate:platforms`
- `pnpm --filter @martinloop/mcp verify:release`
