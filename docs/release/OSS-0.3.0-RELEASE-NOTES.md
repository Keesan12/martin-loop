# MartinLoop 0.3.0

MartinLoop `0.3.0` adds a real share command to the public root CLI.

It is a small release on purpose: finish a governed run, package the evidence cleanly, and hand it to another person without leaking workstation paths.

## What changed

- `martin share --latest` now writes a local share bundle for the latest governed run.
- The bundle includes:
  - `run-receipt.json`
  - `run-receipt.md`
  - `proof-card.svg`
- Generated share artifacts redact absolute workstation paths so the bundle is safe to hand to another person or attach to a ticket.
- The share bundle uses the canonical run directory by default and supports `--out-dir` when you want to write somewhere else.

## Why it matters

Before `0.3.0`, the public CLI could inspect a run, but sharing usually meant copying raw JSON or screenshots by hand. `share` turns the existing run evidence into a tidy bundle that is easier to review, attach, archive, or pass to another engineer.

## Start here

```sh
npx martin-loop doctor
npx martin-loop session-start
npx martin-loop preflight "Summarize the workspace and prove tests still pass" --verify "npm test"
npx martin-loop run "Summarize the workspace and prove tests still pass" --proof --verify "npm test"
npx martin-loop dossier --latest
npx martin-loop share --latest
```

## What you get

After a successful run, `martin share --latest` writes a bundle under the selected run directory in `share/`:

- `run-receipt.json` for machine-readable audit data
- `run-receipt.md` for a human summary
- `proof-card.svg` for a portable visual proof card

If you want the bundle somewhere else, pass `--out-dir <path>`.

## Upgrade notes

- `share` is a packaging step for existing governed evidence; it does not replace `dossier`, `triage`, or `runs get`.
- The public `0.3.0` share surface is local-first. It does not post anywhere, upload anything, or assume hosted infrastructure.
- Absolute paths and file URIs are redacted before the share bundle is written.

## Validation

`0.3.0` ships through the standard public root release gate:

- `pnpm install --frozen-lockfile`
- `pnpm lint`
- `pnpm test`
- `pnpm build`
- `pnpm public:git-surface`
- `pnpm oss:validate`
- `pnpm public:smoke`
- `pnpm release:matrix:local`
- `node ./scripts/root-release-guard.mjs --tag v0.3.0 --pack`
