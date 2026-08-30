# MartinLoop 0.5.6

MartinLoop 0.5.6 hardens the release and packaged MCP paths while carrying forward the governed execution improvements shipped in 0.5.5.

## What changed

- Packaged MCP validation now canonicalizes temporary workspace paths before passing them through the governed preflight boundary, including macOS alias paths.
- MCP runtime and registry metadata now derive from one package-version authority and are checked before release.
- The read-only Arcade MCP App exposes run-inspection resources without adding a second execution authority.
- Hosted run synchronization uses the canonical run-sync contract with replay-safe request behavior.

## Install

```sh
npx -y martin-loop@0.5.6 --version
npx -y martin-loop@0.5.6 start
```

The release is complete only after the npm artifact and GitHub release are visible and independently verified.
