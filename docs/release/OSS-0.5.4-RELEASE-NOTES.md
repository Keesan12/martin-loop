# MartinLoop 0.5.4

MartinLoop 0.5.4 makes autonomous coding runs more capable without handing the safety boundary back to provider prompt loops. You define the governed contract once; MartinLoop negotiates the provider, keeps work inside the approved workspace, runs verification, and returns an accountable outcome with receipt evidence.

## Highlights

### Governed autonomy across providers

The shared execution contract now describes the product intent—`governed-autonomous`—without embedding Codex, Claude, Gemini, IDE, or provider flag names. Codex is the dynamically negotiated reference implementation, while Claude and Gemini map the same intent through their supported autonomous modes.

### Exact-binary Codex negotiation

MartinLoop probes the exact Codex executable selected for the run, discovers supported automation and option scope, and behaviorally proves a writable workspace strategy before spend. Permission controls cannot be replaced through extra arguments, and an unsafe or interactive downgrade is rejected.

### Reliable long-running work

Provider execution timeout is now a finite, provider-neutral run setting that is independent from verifier timeout. Teams can grant legitimate autonomous turns more time while retaining a hard governance stop when the configured limit is reached.

### Better proof surfaces

MCP responses now lead with readable Markdown and retain structured content plus compatibility JSON. Verified Handoff authority remains shared across terminal and MCP surfaces, so the same run cannot receive conflicting outcomes in different clients.

### Grounding and packaging hardening

Grounding recognizes declarations introduced by newly added patch files without weakening missing-file or out-of-scope checks. Internal test compatibility adapters remain available to source-level tests but are stripped from both published root and standalone MCP artifacts.

## Install

```bash
npx -y martin-loop@0.5.4 --version
npx -y martin-loop@0.5.4 start
```

For MCP hosts, use `@martinloop/mcp@0.5.4`.

