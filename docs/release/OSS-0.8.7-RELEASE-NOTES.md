# MartinLoop 0.8.7 — safer rollback and truthful agent completion

MartinLoop 0.8.7 strengthens the safeguards around autonomous coding-agent work. It fixes cases where a failed agent could appear successful, where changes to existing tests or protected files could slip through, and where rollback could follow a linked directory outside the intended repository.

## What's fixed

- **Rollback stays inside the repository.** MartinLoop checks linked paths, including Windows junctions, before reading, restoring, or deleting files during rollback. It stops when it cannot establish a safe boundary rather than modifying linked external files.
- **Existing tests cannot be silently weakened.** Deleting an existing test file, removing or changing an existing assertion (including editing an expected value), dropping a test case, or marking a case as skipped requires explicit `--approve-test-changes`. Adding tests, appending cases, and editing imports or formatting need no approval. Swarm child work cannot grant itself approval beyond its parent contract.
- **Agent commits are checked like any other change.** An agent that commits its edits no longer hides them from path rules. A blocked commit is rewound and its files are restored.
- **Ignored and protected files are checked.** Ignored files that match a denied path are included in change detection, even if their size or modification time does not change. Writes to secret and key files (`.env` and `.env.*` other than templates such as `.env.example`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, and SSH private keys) stop the run unless the file is named explicitly in `--allow-path`. Dependency and build output directories are not inspected file by file, so package installs are unaffected. When a blocked change is safely recoverable, MartinLoop restores it from the attempt's boundary; otherwise it reports failed or unavailable rollback.
- **Failed Claude runs cannot inherit a green baseline test.** A terminal Claude Code error ends the attempt before verification, including when the provider returned structured output. When available, actual provider cost is still recorded.
- **Unchanged workspaces are visible.** When an edit run changes no files, the verified handoff carries a warning, so a passing verifier over an unchanged workspace is not mistaken for completed work.
- **Verifier commands are checked consistently.** MCP preflight rejects malformed verifier commands rather than claiming readiness; valid third-party flags remain supported.
- **Rollback messages match what happened.** If restoration fails, the CLI says so rather than claiming the workspace was unchanged.
- **Large repositories work.** Capturing the pre-attempt state no longer fails on repositories that contain very large git-ignored directories.

## Important execution boundary

MartinLoop checks repository changes and secures its own rollback operations. It is **not an operating-system sandbox** for a coding agent launched with host-level filesystem access. Use an isolated sandbox when you must prevent any writes outside the repository.

## Upgrade

```sh
npx -y martin-loop@0.8.7 --version
npx -y martin-loop@0.8.7 doctor
```

- If an agent is meant to edit a secret file, name it with `--allow-path <file>`. Allowed paths restrict every write, so list the other paths the task needs as well.
- If an agent is meant to rewrite or remove existing tests, pass `--approve-test-changes`.
- If you use the standalone MCP server, upgrade to `@martinloop/mcp@0.8.7`. The CLI, MCP server, plugin manifests, and MCPB product version advance together; MCPB manifest schema remains `0.3`.

## Verification

The release was checked from the packed npm artifacts in a fresh install, not from source. The checks cover failed-provider runs, link-safe rollback with external canary files, protected-file and test-weakening controls, and MCP schema checks, together with valid-input controls confirming that legitimate edits, agent commits, new tests, and dependency installs still complete.
