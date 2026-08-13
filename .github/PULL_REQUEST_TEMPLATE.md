## Summary

<!-- What does this PR do and why? -->

## Product truth

Select exactly one:

- [ ] This PR does not change claim-relevant behavior or public product copy.
- [ ] This PR changes claim-relevant behavior or public copy, and I updated:
  - `docs/product-truth/CLAIMS-REGISTRY.md`
  - `docs/product-truth/claims-registry.json`
  - `docs/product-truth/public-release-truth.json` when versions/counts changed

Evidence added or updated:

<!-- Exact test, source path, receipt or release evidence -->

## Test plan

- [ ] All existing tests pass (`pnpm test`)
- [ ] New behavior has test coverage
- [ ] `node scripts/validate-product-truth.mjs` passes
- [ ] `node scripts/public-release-truth.mjs --check` passes (if versions changed)
