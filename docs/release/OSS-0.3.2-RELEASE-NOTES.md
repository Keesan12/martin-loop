# MartinLoop 0.3.2

`0.3.2` is a release-quality follow-up focused on deterministic `npx` behavior and cleaner public trust documentation.

## Highlights

- `npx martin-loop` version reporting now stays deterministic across workspace and non-workspace launch contexts.
- Public release docs now align with the live standalone MCP baseline (`@martinloop/mcp@0.3.1`).
- A public receipt specification now documents governed-run receipt fields, replay guidance, and trust boundaries.

## Fixed

- **npx version parity:** resolved root CLI version drift when `npx martin-loop` is invoked from monorepos where local workspace bins were previously influencing runtime identity output.
- **MCP baseline truth in docs:** updated public MCP compatibility and onboarding docs to reflect the live `0.3.1` standalone package line.
- **Governed receipt gate parity:** fixed a receipt-scope mismatch in CLI and MCP run gates so preflight receipts without explicit allow/deny path filters no longer block valid governed runs.

## Added

- **Public receipt spec:** `docs/oss/AGENT-RUN-RECEIPTS.md` now provides a customer-facing reference for receipt schema intent, failure categories, evidence boundaries, and replay expectations.

## Verification

- `pnpm release:validate-local`
- `pnpm test`
- `pnpm build`
- `node ./scripts/root-release-guard.mjs --tag v0.3.2 --pack`
- `docs/release/OSS-0.3.2-VALIDATION-EVIDENCE.md`

## Compatibility

- No hosted transport or private control-plane features are added.
- Root and standalone MCP version lines remain independent (`martin-loop` and `@martinloop/mcp`).
