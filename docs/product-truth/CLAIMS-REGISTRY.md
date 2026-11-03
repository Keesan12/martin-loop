# MartinLoop Product Claims Registry

> This file governs public product wording. Code and tests override this file when they conflict. Every present-tense claim must include a status and evidence path.

Machine-readable twin: [`claims-registry.json`](./claims-registry.json)

---

## Governance

| Status | Meaning |
|--------|---------|
| `shipped` | Live in the released CLI/MCP. Backed by code and tests. |
| `partial` | Core primitives exist. Not complete or not in the critical path. |
| `beta` | Available under opt-in flag. Not default. |
| `building` | In active development. Not released. |
| `roadmap` | Planned. No shipped code yet. |

Any PR touching runtime behavior, CLI/MCP outcomes, public copy, package metadata, supported adapters, limits, verification, scope, recovery, test integrity, SANSA, or fleet claims **must** update this registry and `claims-registry.json`.

---

## Capability Matrix

### Verifier-Gated Completion (`verifier-gated-completion`) — **shipped**

**Safe claim:** MartinLoop requires evidence from configured checks before completion counts.

**Prohibited:**
- "Guarantees bug-free software"
- "Proves universal correctness"
- "Automatically safe to merge"

**Evidence:** `packages/contracts/src/index.ts`, `packages/core/src/index.ts`, `packages/cli/src/run-store.ts`

---

### Scope Enforcement (`scope-enforcement`) — **shipped**

**Safe claim:** MartinLoop detects configured out-of-scope changes, rejects the attempt, and can restore the rollback boundary.

**Prohibited:**
- "Blocks every prohibited write before execution"

**Evidence:** `packages/core/src/index.ts`, `packages/core/src/leash.ts`, `packages/core/src/rollback.ts`

---

### Test Integrity — Current (`test-integrity-current`) — **shipped**

**Safe claim:** MartinLoop evaluates suspicious new tests and requires explicit approval when an attempt weakens or removes existing test code.

**Prohibited:**
- "Detects every form of test tampering"

**Evidence:** `packages/core/src/test-integrity.ts`, `packages/core/src/leash.ts`, `packages/core/tests/test-integrity.test.ts`, `packages/core/tests/test-weakening.test.ts`, `packages/core/tests/leash-protected-files.test.ts`, `packages/core/tests/runtime-workspace-hardening.test.ts`

---

### Zero-Config / Guided Setup (`zero-config-boundaries`) — **partial**

**Safe claim:** MartinLoop provides guided setup for verifiers and run limits. Common ecosystems get discovery suggestions.

**Prohibited:**
- "Zero configuration required"
- "Automatic setup" (until supported ecosystems pass clean-install and first-run tests)

**Evidence:** `packages/cli/src/index.ts`, `docs/getting-started/quickstart.md`

---

### Verified Handoff (`verified-handoff`) — **shipped**

**Safe claim:** Every completed run produces a Verified Handoff with a deterministic outcome (VERIFIED / STOPPED / NEEDS_REVIEW) and inspectable evidence.

**Prohibited:**
- "Automatically proves the run is safe to merge"
- "VERIFIED means no bugs"

**Evidence:** `packages/contracts/src/verified-handoff.ts`, `packages/core/src/verified-handoff.ts`, `packages/cli/src/run-store.ts`

---

### Cost / Budget Governance (`cost-budget-governance`) — **shipped**

**Safe claim:** MartinLoop enforces configurable USD and iteration budgets. Budget exits produce STOPPED outcomes.

**Prohibited:**
- "Guarantees minimum cost"

**Evidence:** `packages/contracts/src/index.ts`, `packages/core/src/index.ts`

---

### Rollback / Recovery (`rollback-recovery`) — **shipped**

**Safe claim:** MartinLoop can capture a rollback boundary before execution and restore it after a rejected patch.

**Prohibited:**
- "Guarantees complete rollback in all environments"

**Evidence:** `packages/core/src/rollback.ts`, `packages/contracts/src/index.ts`

---

### SANSA / Fleet (`sansa-fleet`) — **partial**

**Safe claim:** MartinLoop ships provider-free Swarm planning and evidence primitives; governed live fleet execution remains a separately qualified boundary.

**Prohibited:**
- "Fully autonomous governed fleet execution is generally available"

**Evidence:** `packages/core/src/swarm/index.ts`, `packages/core/src/swarm/evidence.ts`, `packages/cli/src/swarm-demo.ts`
