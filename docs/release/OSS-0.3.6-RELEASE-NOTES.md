# MartinLoop 0.3.6 CLI Version Hotfix

`0.3.6` keeps the proof receipt work from `0.3.5` and fixes the installed root CLI version report.

## What Changed

- `npx -y martin-loop@0.3.6 --version` now reports the root `martin-loop` package version.
- The packaged CLI manifest now uses the root package version used by the installed binary.
- The release guard now fails if the vendored CLI manifest version drifts from the root package version.

## Why This Matters

Operators pin root package versions during audits and release checks. The installed CLI must report the same version that npm installed.

## Quick Check

```sh
npx -y martin-loop@0.3.6 --version
npx -y martin-loop@0.3.6 --help
```
