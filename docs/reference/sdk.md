# SDK Reference

Install the root package:

```sh
npm install martin-loop
```

## Basic Usage

```typescript
import { MartinLoop, createClaudeCliAdapter } from "martin-loop";

const loop = new MartinLoop({
  adapter: createClaudeCliAdapter({ workingDirectory: process.cwd() }),
  defaults: {
    workspaceId: "my-workspace",
    projectId: "my-project",
    budget: {
      maxUsd: 3.0,
      softLimitUsd: 2.25,
      maxIterations: 3,
      maxTokens: 20_000
    }
  }
});

const result = await loop.run({
  task: {
    title: "Fix auth regression",
    objective: "Fix the failing auth regression tests",
    verificationPlan: ["pnpm test"],
    repoRoot: process.cwd()
  }
});

console.log(result.decision.status);
```

## Codex Adapter

```typescript
import { MartinLoop, createCodexCliAdapter } from "martin-loop";

const loop = new MartinLoop({
  adapter: createCodexCliAdapter({ workingDirectory: process.cwd() })
});
```

## Lower-Level Runtime

The package also exports `runMartin` for callers that want to assemble the runtime input directly.
