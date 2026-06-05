# martin-loop 0.2.8

MartinLoop `0.2.8` makes first-run setup clearer and adds a stronger default local gate before a governed run begins.

## Highlights

- Guided onboarding now lives in the CLI with `npx martin-loop start`, `npx martin-loop guide`, and `npx martin-loop tour`.
- Governed runs are hard-gated by default. MartinLoop expects recent `doctor`, local session, and `preflight` receipts before `run` will execute real work.
- MCP hosts get clearer built-in workflow guidance through updated resources, prompts, and tool descriptions.
- Docs and package READMEs now explain the same local-first command-center flow.

## Start Here

```sh
npx martin-loop start
npx martin-loop tour
npx martin-loop doctor
npx martin-loop demo
cd martin-loop-demo
npx martin-loop session-start
npx martin-loop preflight "Summarize the demo workspace and prove tests still pass" --verify "npm test"
```

Then run the no-spend proof path:

```sh
MARTIN_LIVE=false npx martin-loop run "Summarize the demo workspace and prove tests still pass" --verify "npm test"
npx martin-loop dossier --latest
```

## Upgrade Notes

- `npx martin-loop run` now blocks until the required local governance receipts exist for the same repo and task.
- `--unsafe-allow-unguarded-run` is available for advanced local operators who intentionally need to bypass the gate.
- `npx martin-loop tour` is the recommended first command for onboarding a human or showing the product flow to an agent host operator.

## Validation

`0.2.8` is intended to pass the local public release gates:

- `pnpm lint`
- `pnpm test`
- `pnpm build`
- `pnpm oss:validate`
- `pnpm public:smoke`
- `pnpm release:validate:platforms`
