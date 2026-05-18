# Grounding Integrity System Spec

## Why this exists
“Hallucination detection” is too soft and too subjective. Martin Loop needs a system that determines whether a patch, claim, or attempted solution is grounded in repo reality and task reality.

## Design goal
Convert grounding from a marketing label into an auditable verdict.

## Core verdicts
- `grounded`
- `grounding_warning`
- `grounding_failure`

## Grounding rules
### Rule 1: Missing symbol
A patch or explanation references a symbol, function, class, module, schema, route, or file that is not present in:
- the repo anatomy index,
- the approved dependency set,
- approved docs or contract artifacts.

### Rule 2: Missing dependency
A patch introduces a dependency or tool that is not already available and not explicitly allowed by the contract.

### Rule 3: Out-of-scope edit
A patch modifies files outside the contract allowlist or outside approved generated outputs.

### Rule 4: Unsupported completion claim
The model claims the task is fixed or complete, but verifier artifacts do not support that claim.

### Rule 5: Contradiction
The patch contradicts the contract, verifier results, or retrieved repo facts.

### Rule 6: Unresolved reference
The changed code introduces unresolved identifiers, imports, or type references.

## Architecture
### 1. Repo anatomy index
Persist a lightweight, refreshable index containing:
- file tree
- module boundaries
- exports/imports
- package manifests
- test files and ownership
- config files
- generated directories
- docs index

### 2. Changed-file symbol scan
For every attempt:
- extract changed files
- parse imports/exports where possible
- detect newly referenced modules
- detect unresolved names from compiler/linter output
- capture dependency deltas

### 3. Contract join
Compare the patch against:
- allowed files
- forbidden files
- allowed commands
- allowed dependency additions
- acceptance criteria
- stop rules

### 4. Verdict engine
Emit a verdict object:
```json
{
  "verdict": "grounding_failure",
  "reasons": ["missing_symbol", "unapproved_dependency"],
  "evidence": {
    "missingSymbols": ["fooClient"],
    "newDependencies": ["left-pad"],
    "changedFiles": ["src/api.ts", "package.json"]
  }
}
```

## Required artifacts
Per attempt persist:
- `grounding.json`
- changed file list
- dependency delta list
- missing symbol list
- unresolved reference list
- scope violations list

## Runtime behavior
- Grounding warning: keep running only if policy allows and no critical violations exist.
- Grounding failure: default action is discard + escalate or retry in grounding quarantine mode.

## Grounding quarantine mode
When grounding failure occurs:
- narrow allowed files to minimal relevant set
- lock retrieval to contract-approved files only
- forbid dependency additions
- reduce patch size budget
- require verifier pass before keep

## Implementation steps
1. Build anatomy snapshot command.
2. Build changed-file extractor.
3. Build dependency delta detector.
4. Build unresolved reference collector from compiler/linter/test output.
5. Implement verdict engine.
6. Wire verdict into keep/discard decision.
7. Add read-model surfaces.

## Acceptance tests
- Fake import introduced -> grounding failure.
- New package added without approval -> grounding failure.
- Patch touches forbidden file -> grounding failure.
- Model claims fixed but tests still fail -> unsupported completion claim.
- Patch only touches allowed files and compiles -> grounded or grounding warning, not failure.
