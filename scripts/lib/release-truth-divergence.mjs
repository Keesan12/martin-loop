import { createHash } from "node:crypto";

const SHA256 = /^[a-f0-9]{64}$/u;
const LANES = new Set(["public", "embedded_mirror"]);

export function normalizeComparisonText(text) {
  return String(text).replace(/\r\n/gu, "\n");
}

export function contentDigest(text) {
  return createHash("sha256").update(normalizeComparisonText(text), "utf8").digest("hex");
}

export function validateDivergenceManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("divergence manifest must be an object");
  }
  if (manifest.schemaVersion !== 1) {
    throw new Error("divergence manifest schemaVersion must be 1");
  }
  if (!Array.isArray(manifest.approvals)) {
    throw new Error("divergence manifest approvals must be an array");
  }

  const seen = new Set();
  const approvals = manifest.approvals.map((approval, index) => {
    if (!approval || typeof approval !== "object" || Array.isArray(approval)) {
      throw new Error(`approval ${index} must be an object`);
    }
    if (!LANES.has(approval.lane)) {
      throw new Error(`approval ${index} has invalid lane`);
    }
    if (typeof approval.relativePath !== "string" || approval.relativePath.length === 0) {
      throw new Error(`approval ${index} has invalid relativePath`);
    }
    if (!SHA256.test(approval.localSha ?? "")) {
      throw new Error(`approval ${index} has invalid localSha`);
    }
    if (!SHA256.test(approval.remoteSha ?? "")) {
      throw new Error(`approval ${index} has invalid remoteSha`);
    }
    if (typeof approval.reason !== "string" || approval.reason.trim().length < 20) {
      throw new Error(`approval ${index} requires a substantive reason`);
    }

    const normalized = {
      lane: approval.lane,
      relativePath: approval.relativePath.replaceAll("\\", "/"),
      localSha: approval.localSha,
      remoteSha: approval.remoteSha,
      reason: approval.reason.trim(),
    };
    const key = divergenceKey(normalized);
    if (seen.has(key)) {
      throw new Error(`duplicate divergence approval: ${normalized.lane}:${normalized.relativePath}`);
    }
    seen.add(key);
    return normalized;
  });

  return approvals;
}

export function reconcileDivergences({ divergences, approvals, convergedLanes = [] }) {
  const converged = new Set(convergedLanes);
  const activeApprovals = approvals.filter((approval) => !converged.has(approval.lane));
  const approvalByKey = new Map(activeApprovals.map((approval) => [divergenceKey(approval), approval]));
  const divergenceByKey = new Map(divergences.map((divergence) => [divergenceKey(divergence), divergence]));

  return {
    approved: divergences.filter((divergence) => approvalByKey.has(divergenceKey(divergence))),
    unapproved: divergences.filter((divergence) => !approvalByKey.has(divergenceKey(divergence))),
    staleApprovals: activeApprovals.filter((approval) => !divergenceByKey.has(divergenceKey(approval))),
  };
}

function divergenceKey(row) {
  return [row.lane, row.relativePath.replaceAll("\\", "/"), row.localSha, row.remoteSha].join("\0");
}
