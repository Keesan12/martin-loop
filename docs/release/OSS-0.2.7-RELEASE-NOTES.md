# martin-loop 0.2.7

MartinLoop `0.2.7` refreshed the public root package surface and tightened release hygiene for the CLI and SDK package.

## What changed

- the published package README, npm metadata, and GitHub-facing release docs now describe the same MartinLoop product surface
- release validation now blocks unsupported process notes and stray non-doc artifacts before a public release can publish
- the public docs tree no longer includes leftover release archives or other non-doc artifacts

## Why it mattered

`0.2.7` was a release-surface cleanup patch rather than a new runtime feature drop. It made the package easier to evaluate and trust because the repo, npm page, and release workflow stayed aligned on one public-facing story.

## Package versions at this release point

| Package | Public version |
| --- | --- |
| `martin-loop` | `0.2.7` |
| `@martinloop/mcp` | `0.2.5` |
