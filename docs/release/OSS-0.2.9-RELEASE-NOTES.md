# martin-loop 0.2.9

MartinLoop `0.2.9` is an incident-response hotfix for the public root package. It repairs the no-spend proof path, tightens Windows portability, restores the normal Claude permission model, and cleans the shipped root tarball surface.

## What changed

- `npx martin-loop run ... --proof` now completes as a real no-spend governed proof when verification passes.
- Windows command resolution now handles npm-style `.cmd` shims correctly for real CLIs such as `codex.cmd` and wrapped verifier commands.
- `--engine openai` now defaults to the hosted OpenAI endpoint instead of assuming a localhost-compatible server.
- Live Claude runs no longer force `--dangerously-skip-permissions`.
- Public CLI help, onboarding, tour output, workflow receipts, and MCP config guidance now consistently use `martin-loop`.
- The public root tarball no longer exposes the vendored internal CLI bin surface inside `dist/vendor/cli/package.json`.

## Start here

```sh
npx martin-loop start
npx martin-loop tour
npx martin-loop doctor
npx martin-loop session-start
npx martin-loop preflight "Summarize the demo workspace and confirm the verifier is green" --verify "npm test"
npx martin-loop run "Summarize the demo workspace and confirm the verifier is green" --proof --verify "npm test"
npx martin-loop dossier --latest
```

## Upgrade notes

- The recommended no-spend path is the same local-first guarded flow the root README documents: `start` -> `tour` -> `doctor` -> `session-start` -> `preflight` -> `run`.
- `--proof` is the public no-spend entrypoint. Host-managed smoke flows can still use environment-owned proof lanes when the launcher controls the process, but normal operator guidance should stay on `--proof`.
- Live Claude users should expect the normal Claude permission model to apply again.
- Windows users can keep using real CLI shims on PATH instead of rewriting commands to machine-specific executables.
- `--unsafe-allow-unguarded-run` still exists for advanced local operators, but it remains an explicit bypass rather than the default path.

## Validation

`0.2.9` ships through the same public root release gate the GitHub Actions release workflow runs:

- `pnpm install --frozen-lockfile`
- `pnpm lint`
- `pnpm public:copy-scan`
- `pnpm public:git-surface`
- `pnpm test`
- `pnpm build`
- `pnpm oss:validate`
- `pnpm public:smoke`
- `pnpm --filter @martinloop/mcp lint`
- `pnpm --filter @martinloop/mcp test`
- `pnpm --filter @martinloop/mcp build`
- `pnpm --filter @martinloop/mcp smoke:pack`
- `pnpm --filter @martinloop/mcp smoke:published:pack`
- `pnpm --filter @martinloop/mcp verify:release`
- `node ./scripts/root-release-guard.mjs --tag v0.2.9 --pack`
