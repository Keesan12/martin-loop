# @martinloop/mcp 0.8.9 — explicit authorized provider fallback

The standalone MCP package advances with MartinLoop 0.8.9 and adds explicit provider fallback authority to governed MCP runs.

- **Fallback is opt-in.** `martin_run` accepts an ordered `fallbackEngines` list; no vendor is added implicitly.
- **Providers are checked before spend.** Authorized fallback runtimes must be available, and remote OpenAI-compatible routes require a configured model and authentication.
- **Run authority is preserved.** A provider switch keeps the same task, scope, verifier, and total MartinLoop budget.
- **Provider truth stays inspectable.** The run reports the provider that actually completed the work rather than always reporting the original primary.
- **No automatic replay of irreversible work.** External-write and irreversible recovery stays fail-closed.

To start the versioned MCP package:

```sh
npx -y @martinloop/mcp@0.8.9
```

MCPB product version is `0.8.9`; manifest schema remains `0.3`.
