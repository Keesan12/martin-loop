# MCP Publishing

Use npm trusted publishing from GitHub Actions for `@martinloop/mcp` releases. Do not rely on local browser login as the primary release path.

## Canonical release path

1. Bump `packages/mcp/package.json` and `packages/mcp/server.json` to the target version.
2. Merge the release branch to `main`.
3. Configure npm trusted publishing once for `@martinloop/mcp`:
   - npm package: `@martinloop/mcp`
   - GitHub owner: `Keesan12`
   - GitHub repository: `martin-loop`
   - GitHub Actions workflow file: `publish-mcp.yml`
4. Trigger `.github/workflows/publish-mcp.yml`:
   - manually with `workflow_dispatch` using the exact existing `mcp-vX.Y.Z` tag in the `tag` input, or
   - by pushing a tag in the form `mcp-vX.Y.Z`.
5. Let the workflow:
   - install with `pnpm install --frozen-lockfile`
   - run `pnpm --filter @martinloop/mcp lint`
   - run `pnpm --filter @martinloop/mcp test`
   - run `pnpm --filter @martinloop/mcp build`
   - run `pnpm --filter @martinloop/mcp smoke:pack`
   - run `pnpm --filter @martinloop/mcp smoke:published:pack`
   - run `pnpm --filter @martinloop/mcp verify:release`
   - publish `@martinloop/mcp`
   - verify the live artifact with `pnpm --filter @martinloop/mcp smoke:published`
   - create the matching GitHub release with the checked-in MCP release notes file as the body

## One-time npm setup

Set up npm trusted publishing on the `@martinloop/mcp` package page:

1. Open npm package settings for `@martinloop/mcp`.
2. Go to the trusted publishing section.
3. Add GitHub Actions as the trusted publisher.
4. Enter:
   - GitHub owner: `Keesan12`
   - repository: `martin-loop`
   - workflow filename: `publish-mcp.yml`
5. After trusted publishing works, restrict token access for the package so browser-auth local publishes are not the normal path.

## Why this is the preferred path

- removes the flaky local browser-auth publish loop
- keeps the publish path reproducible
- uses the same verified package checks every release
- publishes only after pack and published-artifact smoke checks pass
- avoids storing a long-lived npm publish token in GitHub secrets
- gets npm provenance automatically for public packages published from public GitHub repos

## Local emergency fallback

Only use local publish when automation is unavailable:

```powershell
cd "C:\Users\Torram\OneDrive\Documents\Codex Main\Setup Stuff\martin-loop\packages\mcp"
pnpm lint
pnpm test
pnpm build
pnpm smoke:pack
pnpm smoke:published:pack
pnpm verify:release
npm publish --access public --provenance
```

After local publish, always verify:

```powershell
npm view @martinloop/mcp version
pnpm --filter @martinloop/mcp smoke:published
```
