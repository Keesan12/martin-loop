# Contributing to MartinLoop➰

Thanks for helping improve MartinLoop.

MartinLoop is an open-source governed runtime for autonomous AI coding agents. We welcome contributions that make agent runs safer, more inspectable, and easier to integrate into real developer workflows.

## Good first contributions

Good first contributions include:

- Improving docs and examples
- Adding Claude Code walkthroughs
- Adding Codex CLI examples
- Adding OpenCode examples
- Adding GitHub Actions examples
- Improving JSONL run record examples
- Adding tests for budget, verifier, and policy behavior

## Current priority issues

If you are new to the project, start with one of these:

- `good first issue: add Claude Code walkthrough`
- `good first issue: add OpenCode adapter example`
- `docs: add Ralph-style loop safety guide`
- `example: GitHub Actions budget-gated agent run`
- `discussion: what should MartinLoop support next?`

Thank you for helping make autonomous AI coding agents safer, cheaper, and more inspectable.

## Development setup

Requirements:

- Node 20+
- pnpm 10.x

Clone the repo and install dependencies:

```bash
git clone https://github.com/Keesan12/martin-loop.git
cd martin-loop
pnpm install
pnpm test
pnpm lint
pnpm build
