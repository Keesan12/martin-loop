# MartinLoop 0.3.19 — Governed workspace config correction

`0.3.19` corrected a workspace-resolution defect in governed Codex runs and brought the public release surface back into version-truth alignment.

## What changed

### `--cwd` is now the authority for default workspace config

When MartinLoop was launched from one directory but asked to govern a different workspace with `--cwd`, the default `martin.config.yaml` lookup could still resolve from the invocation root. That caused governed runs to pick up the wrong budget and policy defaults.

`0.3.19` fixes that at the CLI boundary:

- default `martin.config.yaml` now resolves from the governed workspace
- budget normalization now reflects the actual target repo
- live Codex governed receipt chains no longer drift onto the caller's local defaults

### Real Codex governed tests now verify supported behavior

The public OSS Codex integration lane now draws a clearer boundary between deterministic unit coverage and host-dependent governed execution:

- deterministic unit tests always run
- Codex-required tests probe real CLI availability
- live governed Codex receipt-chain tests run only when the host is actually ready

This keeps the public test surface aligned with real operator environments and avoids overstating host readiness in environments where Codex is not installed.

### Public release surface tightened

Tracked `.planning` files that did not belong on the public OSS surface were removed, and `.planning/` is now ignored so the same contamination class cannot slip back into the repo.

### Version surfaces resynced

This release also realigns repo metadata with the package lines already live on npm:

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
- public release-surface scan removed tracked internal planning artifacts from the OSS lane
