# MartinLoop 0.6.4

MartinLoop 0.6.4 is a focused reliability release for portable repository guards, truthful in-flight run state, and fail-closed Codex capability detection.

## What changed

- The portability hook now uses the repository-managed scanner and cannot report success when a required scan did not execute.
- Governed runs persist `attempt.started` and expose `activeAttemptId` before waiting on a provider, keeping status, cancellation, and recovery truthful after client timeouts.
- Codex 0.147 multiline capability output is parsed correctly, and supported hosts use explicit `workspace-write` plus `never` only after the boundary probe succeeds.
- Root package, standalone MCP package, plugin metadata, MCPB product version, release-truth metadata, and built runtime version authority align at `0.6.4`.

## Codex on native Windows

Native Windows Codex 0.147 remains temporarily unsupported because its upstream workspace sandbox can fail before MartinLoop execution begins. MartinLoop continues to fail closed in that state. Track the upstream limitation at [openai/codex#39276](https://github.com/openai/codex/issues/39276).

## Upgrade

No configuration changes are required.

```sh
npx -y martin-loop@0.6.4 --version
npx -y martin-loop@0.6.4 doctor
npx -y @martinloop/mcp@0.6.4
```
