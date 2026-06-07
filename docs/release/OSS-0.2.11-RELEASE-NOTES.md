## MartinLoop OSS `0.2.11`

MartinLoop `0.2.11` is a narrow root-package follow-up to `0.2.10`. It closes the remaining public selector mismatch that was still visible after the trust hotfix shipped.

### Fixed

- **`runs verify --latest` now works on the packaged public CLI** - the verification view now accepts `--latest` and resolves it against the same persisted runs root used by `dossier` and `runs get`.
- **Public guidance and shipped behavior are aligned again** - phase-command-center hints, CLI help, and public release guidance no longer point at a selector path the packaged CLI rejects.

### Why this patch exists

`0.2.10` fixed verifier trust and explicit runs-root handling, but a post-publish packaged-artifact repro still found one remaining selector mismatch: `martin-loop runs verify --latest` returned `invalid_input` even though public guidance already referenced it. `0.2.11` fixes that last public parity issue without widening scope.

### Public smoke path

```bash
npx martin-loop doctor --runs-dir ~/.martin/runs
npx martin-loop session-start --runs-dir ~/.martin/runs
npx martin-loop preflight "Summarize the workspace and confirm the verifier is green" --verify "npm test" --runs-dir ~/.martin/runs
npx martin-loop run "Summarize the workspace and confirm the verifier is green" --proof --verify "npm test" --runs-dir ~/.martin/runs
npx martin-loop runs verify --latest --runs-dir ~/.martin/runs
npx martin-loop dossier --latest --runs-dir ~/.martin/runs
```

### Notes

- This is still a **root-package-only** patch release.
- The standalone `@martinloop/mcp` package line remains separate.
