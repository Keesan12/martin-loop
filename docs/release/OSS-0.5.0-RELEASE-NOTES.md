# MartinLoop 0.5.0

MartinLoop 0.5.0 strengthens the evidence behind governed coding-agent runs and expands the supported installation and MCP surfaces.

## What ships

- Fail-closed governed outcomes: a run cannot report `VERIFIED` when required mutation or verifier evidence is absent.
- Fresh verifier provenance bound to the active run, canonical workspace, working directory, and configuration; stale or cross-workspace evidence is rejected.
- Preserved `STOPPED` and `NEEDS_REVIEW` authority through pre-run and post-run rendering.
- Native `martin install` support with checksum validation, atomic replacement, and rollback behavior.
- MCP installation, verification, rollback, and uninstall flows for supported hosts, plus aligned tool validation and machine-readable responses.
- Explicit model authority: `--model` is passed through unchanged; when it is omitted, MartinLoop leaves model selection to the authenticated host runtime.
- Strict positive budget validation, side-effect-free help, and clean JSON output for automation and CI.
- Retained terminal UX improvements from the unpublished 0.4.6 draft.

## Install

```sh
npx -y martin-loop@0.5.0 --version
npx -y @martinloop/mcp@0.5.0
```

For a native CLI installation:

```sh
npx -y martin-loop@0.5.0 install
```

## Run and verify

```sh
npx -y martin-loop@0.5.0 run "Fix the failing test" --verify "npm test" --budget-usd 2 --max-iterations 1
npx -y martin-loop@0.5.0 dossier --latest
npx -y martin-loop@0.5.0 runs verify --latest
```

## Trust boundary

A configured verifier proves only the checks it actually runs. A `VERIFIED` outcome does not mean the code is bug-free, universally correct, or automatically safe to merge. Review the diff, receipt, verifier provenance, and scope before accepting a change.

## Package lines

- `martin-loop`: `0.5.0`
- `@martinloop/mcp`: `0.5.0`
- MCPB bundle: remains on its previously released `0.3.9` artifact and is not advanced by this release.

See [VERSION-LEDGER.md](./VERSION-LEDGER.md) for the release map.
