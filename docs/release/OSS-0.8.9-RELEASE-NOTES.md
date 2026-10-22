# MartinLoop 0.8.9 — explicit provider fallback and durable run continuation

MartinLoop 0.8.9 closes two remaining autonomy gaps: a governed run can use a provider fallback only when the user explicitly authorized it, and a safely interrupted reversible run can continue from persisted evidence instead of starting over.

## What's new

- **Explicit provider fallback.** CLI runs can use repeatable `--fallback-engine` options and MCP `martin_run` accepts an ordered `fallbackEngines` list. MartinLoop never adds a vendor implicitly.
- **Fail-closed provider authority.** Fallback providers are checked before spend. A continued run cannot add or change providers beyond the authority persisted on the original run.
- **Same-run continuation.** `martin continue <loopId>` continues eligible persisted work under the original loop ID, task, verifier, scope, and remaining budget.
- **Repair context survives reconnects.** Retained candidate state, the pre-candidate rollback boundary, and the latest verifier failure evidence are restored so the next attempt can repair the existing candidate rather than rebuild blindly.
- **Single execution owner.** A durable execution lease prevents two reconnecting clients from launching concurrent provider children for the same run.
- **Hard limits remain hard.** USD, token, iteration, and wall-clock authority survive reconnects. Restarting the client does not grant a fresh time budget.
- **Truthful refusal for unsafe work.** Terminal or exhausted runs, uncertain active attempts, irreversible tasks, and external-write tasks are not automatically continued.

## Provider fallback boundary

Fallback does not mean automatic vendor routing. A fallback must already be explicitly named by the user and available to the runtime. Remote OpenAI-compatible fallback requires a configured model and authentication; local endpoints may operate without an API key.

MartinLoop preserves the same task, allowed/denied scope, verifier, and total run budget across provider switches. Provider changes remain visible in run evidence.

## Upgrade

```sh
npx -y martin-loop@0.8.9 --version
npx -y martin-loop@0.8.9 doctor
```

Example explicitly authorized fallback:

```sh
npx -y martin-loop@0.8.9 run "Fix the failing test" \
  --engine claude \
  --fallback-engine codex \
  --verify "npm test"
```

Continue an eligible persisted run:

```sh
npx -y martin-loop@0.8.9 continue LOOP_ID
```

If you use the standalone MCP server, upgrade it to `@martinloop/mcp@0.8.9`. The root CLI, MCP package, plugins, and MCPB product version advance together; MCPB manifest schema remains `0.3`.
