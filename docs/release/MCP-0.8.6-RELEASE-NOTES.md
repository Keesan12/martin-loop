# @martinloop/mcp 0.8.6 — tool schemas match tool behavior

The standalone MCP package advances with MartinLoop 0.8.6 and remains aligned with the root package, plugin metadata, and MCPB product version.

- `martin_preflight` returns results on hosts where Codex is installed; its Codex diagnostics are now part of the advertised output schema.
- `martin_dossier`, `martin_pr_summary`, `martin_create_pr`, `martin_review_pr`, `martin_pause`, `martin_cancel`, and `martin_continue` accept every argument they advertise.
- `martin_arcade_status` reports runs whose outcome is `NEEDS_REVIEW`.
- `martin_create_pr` with `execute: true` opens a pull request only for a verified run with intact receipts.

The MCPB manifest schema remains `0.3`.
