import test from "node:test";
import assert from "node:assert/strict";

import {
  contentDigest,
  reconcileDivergences,
  validateDivergenceManifest,
} from "../lib/release-truth-divergence.mjs";

test("content digests ignore checkout-only CRLF differences", () => {
  assert.equal(contentDigest("first\nsecond\n"), contentDigest("first\r\nsecond\r\n"));
});

test("exact path and hash approvals reconcile one reviewed divergence", () => {
  const divergence = {
    lane: "public",
    relativePath: "packages/cli/src/mcp-config.ts",
    localSha: "a".repeat(64),
    remoteSha: "b".repeat(64),
  };
  const result = reconcileDivergences({
    divergences: [divergence],
    approvals: [divergence],
  });

  assert.deepEqual(result, { approved: [divergence], unapproved: [], staleApprovals: [] });
});

test("a marker or path-only approval cannot bless changed bytes", () => {
  const divergence = {
    lane: "public",
    relativePath: "packages/cli/src/mcp-config.ts",
    localSha: "a".repeat(64),
    remoteSha: "b".repeat(64),
  };
  const pathOnly = {
    lane: "public",
    relativePath: divergence.relativePath,
    localSha: "c".repeat(64),
    remoteSha: divergence.remoteSha,
  };

  const result = reconcileDivergences({ divergences: [divergence], approvals: [pathOnly] });
  assert.deepEqual(result.approved, []);
  assert.deepEqual(result.unapproved, [divergence]);
  assert.deepEqual(result.staleApprovals, [pathOnly]);
});

test("an exact-commit converged lane retires old approvals without blessing dirty bytes", () => {
  const oldApproval = {
    lane: "public",
    relativePath: "packages/cli/src/index.ts",
    localSha: "a".repeat(64),
    remoteSha: "b".repeat(64),
  };

  const clean = reconcileDivergences({
    divergences: [],
    approvals: [oldApproval],
    convergedLanes: ["public"],
  });
  assert.deepEqual(clean, { approved: [], unapproved: [], staleApprovals: [] });

  const dirty = reconcileDivergences({
    divergences: [oldApproval],
    approvals: [oldApproval],
    convergedLanes: ["public"],
  });
  assert.deepEqual(dirty, { approved: [], unapproved: [oldApproval], staleApprovals: [] });
});

test("convergence in one lane does not retire approvals from another lane", () => {
  const mirrorApproval = {
    lane: "embedded_mirror",
    relativePath: "packages/mcp/src/server.ts",
    localSha: "c".repeat(64),
    remoteSha: "d".repeat(64),
  };
  const result = reconcileDivergences({
    divergences: [],
    approvals: [mirrorApproval],
    convergedLanes: ["public"],
  });
  assert.deepEqual(result.staleApprovals, [mirrorApproval]);
});

test("divergence manifest validation rejects duplicates and malformed hashes", () => {
  assert.throws(
    () => validateDivergenceManifest({ schemaVersion: 1, approvals: [
      { lane: "public", relativePath: "x", localSha: "short", remoteSha: "b".repeat(64) },
    ] }),
    /localSha/u,
  );

  const approval = {
    lane: "public",
    relativePath: "x",
    localSha: "a".repeat(64),
    remoteSha: "b".repeat(64),
    reason: "Reviewed exact divergence for this test fixture.",
  };
  assert.throws(
    () => validateDivergenceManifest({ schemaVersion: 1, approvals: [approval, approval] }),
    /duplicate/u,
  );
});

test("divergence manifest requires a substantive review reason", () => {
  assert.throws(
    () => validateDivergenceManifest({ schemaVersion: 1, approvals: [{
      lane: "public",
      relativePath: "packages/cli/src/mcp-config.ts",
      localSha: "a".repeat(64),
      remoteSha: "b".repeat(64),
    }] }),
    /reason/u,
  );
});
