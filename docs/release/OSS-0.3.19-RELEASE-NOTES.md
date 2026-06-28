# MartinLoop 0.3.19 — Governed Codex truth lock and repository cleanup

`0.3.19` ships a governance correctness fix for real MartinLoop Codex runs and cleans up public repo drift that should not have remained on the OSS surface.

## What changed

### `--cwd` is now the authority for default workspace config

When MartinLoop was launched from one directory but asked to govern a different workspace with `--cwd`, the default `martin.config.yaml` lookup could still resolve from the invocation root. That caused governed runs to pick up the wrong budget and policy defaults.

`0.3.19` fixes that at the CLI boundary:

- default `martin.config.yaml` now resolves from the governed workspace
- budget normalization now reflects the actual target repo
- live Codex governed receipt chains no longer drift onto the caller's local defaults

### Real Codex governed tests now verify supported behavior

The public OSS Codex integration lane no longer leans on fake subprocess presence for governed run behavior. The supported split is now explicit:

- deterministic unit tests always run
- Codex-required tests probe real CLI availability
- live governed Codex receipt-chain tests run only when the host is actually ready

This makes the public test surface more honest and keeps MartinLoop aligned with real operator environments.

### Public planning residue removed

Tracked `.planning` files that did not belong on the public OSS surface were removed, and `.planning/` is now ignored so the same contamination class cannot slip back into the repo.

### Version surfaces resynced

This release also normalizes repo metadata that had drifted behind live package truth:

- root package advances to `0.3.19`
- standalone `@martinloop/mcp` metadata now reflects the already-live `0.3.6` line

## Upgrade

```sh
npx -y martin-loop@0.3.19 --version
npx -y martin-loop@0.3.19 start
```

## Validation highlights

- real Codex CLI integration lane passed in a live Codex environment after the config-root fix
- public deterministic CLI governance tests passed
- public repo contamination cleanup removed tracked internal planning surfaces
