# MartinLoop 0.5.8

MartinLoop 0.5.8 is a focused corrective release for governed runs that create a fresh, explicitly allowed acceptance artifact.

## What changed

- Keeps verifier-passing artifacts created during an attempt when the requested path is explicitly allowed.
- Preserves grounding protection for changed-file claims that are not backed by actual workspace state.
- Adds focused regression coverage for fresh acceptance artifacts in the runtime patch-truth path.

## Install

```sh
npx -y martin-loop@0.5.8 --version
npx -y martin-loop@0.5.8 start
```

Use this release instead of `0.5.7` for fresh governed E2E validation.
