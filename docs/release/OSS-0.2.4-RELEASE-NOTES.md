# MartinLoop OSS `0.2.4` Release Notes

`martin-loop@0.2.4` packages the MartinLoop prompt pack as a documented public surface for safer autonomous coding loops.

## What shipped

- `martin_start`
- `martin_preflight`
- `martin_triage`
- `martin_resume`
- `martin_prove`
- `martin_release_check`
- compatibility aliases for older prompt names
- prompt docs that separate kickoff, retry, proof, and release-check paths

## Why it matters

The prompt pack gives agents a consistent starting point when they need to preflight a task, recover from a failed run, or prepare release evidence without improvising the workflow each time.

## Upgrade

```sh
npm install -g martin-loop@0.2.4
```

## Suggested post-upgrade checks

```sh
npx martin-loop doctor
npx martin-loop triage
npx martin-loop dossier --latest
```

For MCP hosts, refresh/discover prompts and confirm these entries appear:

- `martin_start`
- `martin_preflight`
- `martin_triage`
- `martin_resume`
- `martin_prove`
- `martin_release_check`

## Verify after upgrade

Open the MCP host prompt list and confirm the MartinLoop prompts appear alongside the resource surfaces already shipped in earlier slices.

## Boundary

`0.2.4` adds reusable prompts only. It does not add new MCP tools, shared operator workflows, or other non-OSS prompt catalogs.
