# MartinLoop 0.5.7

MartinLoop 0.5.7 hardens the release tooling and OSS boundary while carrying forward the packaged MCP improvements shipped in 0.5.6.

## What changed

- MCP tool schemas and descriptions hardened for Glama registry A-grade compliance.
- Shared npm pack parser added with fixture coverage for v9, v10, scoped, and mixed shapes.
- Promotion guard CI scoping restricted to public-staging branches to eliminate false positives on internal branches.
- Machine-readable discovery files (`llms.txt`, `llms-full.txt`) ported to the public repository surface.
- OSS boundary allow-list updated to include llms discovery files.
- Receipt integrity chain type narrowing eliminates unknown erasure through the hosted sync payload.

## Install

```sh
npx -y martin-loop@0.5.7 --version
npx -y martin-loop@0.5.7 start
```

The release is complete only after the npm artifact and GitHub release are visible and independently verified.
