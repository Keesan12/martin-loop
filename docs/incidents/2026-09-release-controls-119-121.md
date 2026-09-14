# Release control incidents 119-121

This record preserves the structural lessons from the 0.6.2 release without changing that shipped release. GitHub issues remain the status authority; this document is the repository training record.

## INC-119 — incomplete public promotion surface

```text
BUG_ID=119
SURFACE=public promotion
SEVERITY=P1
REPRO_STEPS=Promote a hand-selected file list while a lockfile, test, or package-smoke file differs from the validated source.
EXPECTED=Every tracked file in the recursively-derived release surface matches validated source unless an exact content-addressed divergence was reviewed.
ACTUAL=The promotion mechanism could accept an incomplete hand-selected surface.
SOURCE_REPO=private OSS staging repository
LIKELY_OWNER=release engineering
USER_IMPACT=Published source could differ from the tree that passed private validation.
EVIDENCE=GitHub issue 119 and regression scenarios A-C in scripts/tests/verify-public-promotion.test.mjs
FIX_STATUS=FIXED_AND_TESTED
REGRESSION_PROOF=pnpm test:release-controls
FIRST_OBSERVED=2026-09-09
AFFECTED_RELEASES=0.6.2 release process
CATEGORY=RELEASE
ROOT_CAUSE=Promotion completeness was represented by a manually selected set rather than a content-addressed recursive inventory.
CONTRIBUTING_FACTORS=Broad divergence markers were not bound to exact paths, hashes, reasons, and reviewers.
CORRECTIVE_ACTION=Generate a canonical v2 manifest from the validated private tree and compare the complete public surface by path and SHA-256.
PREVENTIVE_CONTROL=Fail on every missing, extra, or changed surface file unless an exact reviewed divergence is present.
STATUS=CONFIRMED
```

## INC-120 — tags cut before exact publish source was proven

```text
BUG_ID=120
SURFACE=release tag creation
SEVERITY=P1
REPRO_STEPS=Create release tags before the complete publisher-equivalent matrix succeeds for the candidate commit.
EXPECTED=The exact candidate SHA passes the complete matrix before root and MCP tags are created atomically on that SHA.
ACTUAL=Tag creation could precede full publisher-equivalent validation and root/MCP tag writes were not one atomic operation.
SOURCE_REPO=private OSS staging repository
LIKELY_OWNER=release engineering
USER_IMPACT=A tag could identify source that had not passed the same controls used by publication.
EVIDENCE=GitHub issue 120 and regression scenario F in scripts/tests/release-controls.test.mjs
FIX_STATUS=FIXED_AND_TESTED
REGRESSION_PROOF=pnpm test:release-controls
FIRST_OBSERVED=2026-09-09
AFFECTED_RELEASES=0.6.2 release process
CATEGORY=RELEASE
ROOT_CAUSE=Validation and tag mutation were separate, weakly-bound workflow phases.
CONTRIBUTING_FACTORS=Publish workflows repeated validation only after tag events had already fired.
CORRECTIVE_ACTION=Create an exact-SHA pre-tag attestation and allow one atomic paired-tag push only after it passes.
PREVENTIVE_CONTROL=Publishers are manual-dispatch-only and require the attested SHA plus both tag coordinates.
STATUS=CONFIRMED
```

## INC-121 — repair publisher/source coordinate mismatch

```text
BUG_ID=121
SURFACE=root and MCP publishers
SEVERITY=P1
REPRO_STEPS=Dispatch a publisher when the selected tag, paired tag, checked-out HEAD, and validated release SHA do not all agree.
EXPECTED=Both publishers use one shared coordinate contract and only infrastructure failure may retry the same validated tags.
ACTUAL=Root and MCP publishers used asymmetric source selection and had no shared recovery-state model.
SOURCE_REPO=private OSS staging repository
LIKELY_OWNER=release engineering
USER_IMPACT=A repair publish could build from source different from the validated tag-bound source.
EVIDENCE=GitHub issue 121 and regression scenarios D-E in scripts/tests/release-controls.test.mjs
FIX_STATUS=FIXED_AND_TESTED
REGRESSION_PROOF=pnpm test:release-controls
FIRST_OBSERVED=2026-09-09
AFFECTED_RELEASES=0.6.2 release process
CATEGORY=RELEASE
ROOT_CAUSE=Publisher source coordinates and recovery semantics were duplicated rather than shared.
CONTRIBUTING_FACTORS=One publisher followed branch context while the other followed a tag.
CORRECTIVE_ACTION=Use shared fail-closed recovery states and require HEAD, selected tag, paired tag, and validated SHA equality.
PREVENTIVE_CONTROL=Block stale or partial tag coordinates before dispatch; permit same-tag retry only for classified infrastructure failure.
STATUS=CONFIRMED
```

## Recursive learning extraction

Implementation and review evidence:

- Private PR: `#122`
- Merged commit: `64f9fef09f585e7bae7579e88db71d6ae8ea31d9`
- Deterministic release-control tests: `17/17 PASS`
- Full repository script suite: `150/150 PASS`
- Independent final review: no Critical or Important findings
- GitHub issues `#119`, `#120`, and `#121`: closed as completed

- Completeness controls must derive from ownership roots, not a remembered file checklist.
- Allowlisted divergence must be content-addressed, review-attributed, and narrow enough to expire when content changes.
- Mutation follows validation: first attest an immutable candidate, then atomically establish all release coordinates.
- Every publisher for a coordinated release consumes the same source-coordinate contract and recovery state machine.
- Publication retries are not source-repair tools. A source mismatch returns to pre-publish repair and full validation.
