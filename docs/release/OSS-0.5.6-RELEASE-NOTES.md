# MartinLoop 0.5.6

MartinLoop 0.5.6 makes governed execution safer to operate and easier to connect to a hosted control plane.

Highlights:

- Rollback now stops safely when repository or file state cannot be proven, preserving operator work instead of inferring an empty baseline.
- A `VERIFIED` outcome now requires at least one real, successful, bound verifier command. Execution-only runs remain supported and are reported honestly as non-verified.
- Hosted sync can transmit run metadata and evidence while keeping source-code upload disabled by default.
- The MCP server adds a read-only Arcade resource for compact operator status views.
- CLI, MCP, server, plugin, and packaged artifacts share one checked `0.5.6` version authority.
- MCP package smoke tests use portable path handling for clean installs across Windows, macOS, and Linux.

This release does not change the core trust model: receipts describe recorded evidence, and governed completion still depends on successful verifier evidence.
