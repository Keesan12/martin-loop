# MartinLoop 0.8.6 — failed provider turns are never verified

MartinLoop 0.8.6 closes correctness gaps found by independent end-to-end testing of 0.8.5 on fresh installs.

## What changed

- **Failed provider turns fail the attempt.** When a Codex turn fails — a usage limit, authentication, or network error — the attempt now fails before the verifier runs. Previously the verifier could pass against the unchanged workspace and the run was reported as verified.
- **CommonJS projects keep correct patches.** Patch grounding recognises built-in callables such as `require`, `setTimeout`, and `parseInt`, test-runner globals such as `describe` and `expect`, and methods defined by the patch itself. Calls to functions that exist nowhere are still reported.
- **Verifier flags.** `--verify` accepts verifier programs whose own flags share generic names, for example `node ./verify.js --engine browser` or `npm test -- --engine chromium`. A stray quote that merges MartinLoop's own flags into the verifier on Windows is still rejected.
- **Tamper detection fails the command.** `runs verify` exits with code 7 when a persisted record no longer matches its signed snapshot, so exit-code-only checks catch it.
- **Portable project MCP configs.** Project-scoped configs for every supported host leave out the installing machine's working directory and default runs root, so they can be committed and shared. A runs root chosen with `--runs-dir` is still written.
- **MCP tools match their schemas.** `martin_preflight` returns results on hosts with Codex installed, every documented argument of the dossier, pull-request, and run-control tools is accepted, and `martin_arcade_status` reports runs that need review.
- **Pull requests only from verified work.** `martin_create_pr` with `execute: true` opens a pull request only when the run is verified with intact receipts. Previews are unchanged.

The root package, standalone MCP package, plugin metadata, and MCPB product version are aligned at `0.8.6`.
