# @martinloop/mcp 0.3.6 Release Notes

## HTTP transport and mode-aware hosts

`0.3.6` expands the standalone MCP package in two practical ways: it can now
serve a local HTTP endpoint for bridge-style setups, and agents can read the
current MartinLoop working mode before they decide how to proceed.

### What's new

**Local HTTP transport**

Run the packaged server over HTTP when a local bridge or proxy needs an MCP
endpoint:

```sh
npx -y @martinloop/mcp --http --port 3033
```

stdio remains the default transport for direct host installs.

**`martin://agent/mode-status` resource**

Hosts can now read the active MartinLoop mode, whether it is inherited or
explicitly configured, and the exact commands that switch between `auto`,
`plan`, and `edits`.

### Why it matters

- Bridge-style local integrations no longer need a custom wrapper just to
  expose MartinLoop over HTTP.
- Agents can see whether they should operate autonomously or pause for plan or
  edit confirmations before they start spending budget.

### Verification

- MCP package metadata, `server.json`, and release notes aligned at `0.3.6`.
- Discovery tests confirm the new `mode-status` resource is listed and
  readable.
- Server validation tests cover stdio compatibility plus the new HTTP startup
  path.
