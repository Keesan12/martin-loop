# @martinloop/mcp 0.3.3

`0.3.3` hardens run-history reliability for MCP clients that operate against large local run stores.

## What changed

- MCP run discovery paths now prefer a bounded append-only run index before falling back to full directory scans.
- `latest` and list-style inspection flows stay responsive even when the runs directory contains large historical volume.
- Compatibility behavior is preserved: if index entries are missing or stale, MCP falls back to canonical run-directory reads.
- No runtime execution policy changes were introduced in this release.

## Why this matters

MCP hosts such as Cursor, Copilot, and other IDE integrations frequently call latest/list inspection paths. This release reduces timeout-style failures caused by scanning very large run histories.

## Quick check

```sh
npx -y @martinloop/mcp@0.3.3
```

Then call the MCP list/latest run tools against your normal runs root and confirm responses remain fast and stable.
