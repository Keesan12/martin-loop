# MartinLoop 0.8.5 — safer verifier input and clearer evidence discovery

MartinLoop 0.8.5 closes input-handling and output-contract gaps found during evaluator testing of 0.8.4.

## What changed

- A malformed `--verify` value no longer produces a ready preflight. If a verifier contains an unterminated quote, or contains MartinLoop's own options because the shell merged later flags into it (for example a stray quote passed through the npm command shim on Windows), `run`, `preflight`, and `enable` stop with `invalid_input` and exit code 2 before anything is written. Ordinary verifier commands, including tool flags such as `--json`, are unchanged.
- `runs list` states which workspace it is listing. When the current workspace has no runs but the runs root holds runs for other workspaces, it reports how many and points to `--all-workspaces`, which lists the whole runs root on request. `runs get --latest` gives the same explanation. The default scope is unchanged.
- `badge --governed --format json` now includes the Shields endpoint fields used by `badge --format json`, while keeping its existing fields.
- `demo --swarm` and `swarm status` make clear that the demo is a non-persisted local simulation and show where its evidence lives.
- Process-tree cleanup on macOS and Linux treats an owned process group that only contains defunct (zombie) entries as closed. Unreadable or ambiguous process information still fails closed.
- The `mcp` missing `--host` suggestion lists every supported host.

The root package, standalone MCP package, plugin metadata, and MCPB product version are aligned at `0.8.5`.
