# Security Policy Model

MartinLoop treats agent execution as a bounded contract. A run should know what it is allowed to do before it starts.

Policy checks include:

- verifier command safety
- allowed and denied path rules
- dependency or migration changes that require review
- removing or rewriting existing test code, which requires `--approve-test-changes`
- writes to secret and key files (`.env`, `.env.*` other than templates such as `.env.example`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa`-style private keys)
- secret-like values in task text
- prompt and tool-output patterns that attempt to override the run contract

When a check fails, MartinLoop stops or escalates instead of silently continuing and attempts to restore the workspace to its pre-attempt state. A run reports rollback as failed or unavailable when that state cannot be proved; the CLI does not claim the workspace is unchanged in those cases.

## What the file checks cover

- Changes are compared with the commit that was checked out when the attempt started, so work an agent commits during the attempt is checked the same way as uncommitted work. If a committed change is blocked, the commit is rewound and the files are restored.
- Git-ignored files created, modified, or deleted during an attempt are checked against denied paths and secret-file rules. Dependency and build output directories (for example `node_modules/`, `dist/`, `coverage/`) are not inspected file by file, so package installs and builds are unaffected. Blocked ignored files that the attempt created are deleted. Protected pre-existing ignored files are restored from a bounded in-memory snapshot when safe restoration can be proved; their contents are not persisted in run artifacts.
- Repository paths are collapsed at the first symlink or Windows junction. MartinLoop never reads, writes, restores, or recursively removes through a link; an attempt-created escaping link may be unlinked as the leaf object itself, while a pre-existing operator link is preserved.
- Adding new tests, appending test cases, growing an import list, and reformatting an existing test file need no approval. Approval (`--approve-test-changes`) is required when an agent deletes a test file, removes or changes an existing assertion (including editing an expected value), drops a test case, or marks a case skipped. Data and golden files under test directories, and test files the check cannot parse, are held to a stricter rule: removing any line needs approval.
- To let an agent edit a secret file, name that file explicitly in `--allow-path` (for example `--allow-path .env --allow-path "src/**"`; allowed paths restrict every write, so list the other paths the task needs as well). Wildcards such as `**` do not approve secret files.
- When an edit run changes no files, the verified handoff includes a warning that the verifier result reflects the workspace as it already was.

## Limits

MartinLoop checks the repository it governs. It does not sandbox the agent process itself: writes outside the repository root, network access by the agent, and other host-level effects are contained by the agent provider's own sandbox and permission settings. Run agents with the provider's workspace-write sandbox when you need those guarantees.
