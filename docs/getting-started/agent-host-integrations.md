# Agent Host Integrations

Use MartinLoop from MCP-capable coding-agent hosts without replacing the host itself.

This guide covers Roo Code, Cline, and OpenCode. It also states the current Aider boundary so users do not mistake a planned adapter for a shipped integration.

## What This Governs

A task is governed when the host launches it through MartinLoop's MCP flow:

1. `martin_doctor`
2. `martin_plan`
3. `martin_preflight`
4. `martin_run`
5. `martin_dossier`

MartinLoop then owns the task budget, verifier gate, stop reason, and run receipt.

MartinLoop does **not** silently intercept every native action performed by Roo Code, Cline, or OpenCode. Work executed outside the MartinLoop tool flow remains outside the MartinLoop governance boundary.

## Add a Three-Line Policy

Create `martin.config.yaml` in the repository root:

```yaml
budget: { maxUsd: 3, maxIterations: 3 }
governance:
  verifierRules: ["npm test"]
```

Replace `npm test` with the repository's real verifier. A timeout, missing command, or invented test is not a pass.

## Roo Code

Add a project-level `.roo/mcp.json` file:

```json
{
  "mcpServers": {
    "martin-loop": {
      "command": "npx",
      "args": ["-y", "@martinloop/mcp"],
      "alwaysAllow": [
        "martin_doctor",
        "martin_plan",
        "martin_preflight"
      ],
      "disabled": false
    }
  }
}
```

Keep `martin_run` approval-gated until the team has reviewed the policy and verifier command.

## Cline

Add MartinLoop through Cline's MCP settings or `~/.cline/mcp.json`:

```json
{
  "mcpServers": {
    "martin-loop": {
      "command": "npx",
      "args": ["-y", "@martinloop/mcp"],
      "disabled": false,
      "autoApprove": [
        "martin_doctor",
        "martin_plan",
        "martin_preflight"
      ]
    }
  }
}
```

Keep `martin_run` out of `autoApprove` so the first live governed execution remains visible to the user.

## OpenCode

Add MartinLoop to `opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "martin-loop": {
      "type": "local",
      "command": ["npx", "-y", "@martinloop/mcp"],
      "enabled": true
    }
  }
}
```

Ask OpenCode to use the MartinLoop tools in the required order instead of running the task directly.

## Example Prompt

```text
Use MartinLoop for this task. Run martin_doctor, martin_plan, and martin_preflight first.
Only call martin_run after preflight passes. Use the verifier from martin.config.yaml.
When the run stops, return the MartinLoop dossier and receipt path.
```

## Verify the Integration

A credible integration demo should prove all of the following:

- the host can discover the MartinLoop MCP tools
- `martin_run` is blocked when readiness or preflight is skipped
- the configured verifier actually executes
- the run stops before exceeding the configured budget or iteration cap
- `martin_dossier` reports the stop reason, verifier result, budget posture, and receipt integrity

## Aider Status

MartinLoop does not currently ship a native Aider engine or generic executable adapter. Do not describe Aider as a live governed integration yet.

The correct prerequisite is a tested adapter that can launch Aider, normalize usage and exit status, enforce the MartinLoop budget before another attempt, run an independent verifier, and write the same signed receipt format used by the existing adapters.

## Distribution Guidance

Upstream documentation should describe MartinLoop as an optional external governance layer, not as a replacement for the host and not as a blanket interceptor of native host behavior.

The accurate claim is:

> Tasks launched through MartinLoop receive a hard budget, required verifier gate, explicit stop condition, and signed run receipt.

Avoid claiming that installing the MCP server automatically governs every host session.