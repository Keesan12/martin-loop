# Contributing to MartinLoop

Thanks for helping improve MartinLoop.

MartinLoop is an open-source governed runtime for AI coding agents. We welcome contributions that make agent runs safer, more inspectable, and easier to integrate into real developer workflows.

## Good first contributions

- Improve docs and examples.
- Add Claude Code, Codex, Gemini, and MCP walkthrough clarity.
- Add tests for budget, verifier, policy, and integrity behavior.
- Improve benchmark reproducibility and receipt explainability.

## Development setup

Requirements:

- Node 20+
- pnpm 10.x

```bash
git clone https://github.com/Keesan12/martin-loop.git
cd martin-loop
pnpm install --frozen-lockfile
pnpm lint
pnpm test
pnpm build
pnpm oss:validate
```

## Template: Add a New Failure Mode

When adding a new failure mode, open a PR that includes all fields below so maintainers can review it quickly and consistently.

```md
## Failure mode proposal

- Label: `<snake_case_failure_label>`
- Classification family: `<budget|verifier|policy|integrity|selector|auth|provider|workspace|artifact|other>`
- Trigger: `<exact condition that causes this mode>`
- Guardrail behavior: `<fail-closed action, retry policy, escalation>`
- Expected lifecycle state: `<completed|failed|budget_exit|blocked|...>`
- Evidence anchors:
  - `<event type or field path #1>`
  - `<event type or field path #2>`

## Reproduction

1. `<step>`
2. `<step>`
3. `<step>`

## Verification

- [ ] Added/updated tests for classification.
- [ ] Added/updated docs (include `docs/agent-failure-atlas.md` if relevant).
- [ ] Verified `dossier`, `runs verify`, and `share` behavior for this mode.
```

## PR checklist

- Keep copy user-facing, concise, and accurate.
- Include focused tests for behavior changes.
- Avoid unrelated formatting churn.
- Include commands run and outcomes in the PR description.

Thanks for helping make agent execution safer, cheaper, and more trustworthy.
