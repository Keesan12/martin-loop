# martin-loop 0.2.9

MartinLoop `0.2.9` is an incident-response hotfix for the public root package. It repairs the proof path, tightens Windows portability, and removes a risky default from live Claude runs.

## What changed

- `npx martin-loop run ... --proof` now completes as a real no-spend governed proof when verification passes.
- Windows command resolution now handles npm-style `.cmd` shims correctly for real CLIs such as `codex.cmd` and wrapped verifier commands.
- `--engine openai` now defaults to the hosted OpenAI endpoint instead of assuming a localhost-compatible server.
- Live Claude runs no longer force `--dangerously-skip-permissions`.
- Public CLI help, onboarding, tour output, and MCP config guidance now consistently use `martin-loop`.

## Start here

```sh
npx martin-loop start
npx martin-loop tour
npx martin-loop doctor
npx martin-loop preflight "Summarize the demo workspace and confirm the verifier is green" --verify "npm test"
```

## Upgrade notes

- The recommended no-spend flow is:

```sh
npx martin-loop run "Summarize the demo workspace and confirm the verifier is green" --proof --verify "npm test"
```

- Live Claude users should expect the normal Claude permission model to apply again.
- Windows users can keep using real CLI shims on PATH instead of rewriting commands to machine-specific executables.
- `--unsafe-allow-unguarded-run` still exists for advanced local operators, but the normal public path remains `start` -> `doctor` -> `preflight` -> `run`.

## Validation

`0.2.9` is intended to pass the same public release gate as the normal root release line:

- `pnpm lint`
- `pnpm test`
- `pnpm build`
- `pnpm public:copy-scan`
- `pnpm public:git-surface`
- `pnpm oss:validate`
- `pnpm public:smoke`
- `pnpm release:validate-local`
