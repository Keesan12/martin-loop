// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

export const PRODUCTION_EXECUTION_TRUST_BOUNDARY = "trusted-local-host-with-github-time-anchors-v1";

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function assertRepository(repository) {
  if (typeof repository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(repository)) {
    throw new Error("anchor repository must be an owner/name slug");
  }
}

export function parseGitHubRepositoryFromRemoteUrl(remoteUrl, expectedRepository) {
  assertRepository(expectedRepository);
  let path;
  const scp = /^git@github\.com:(.+)$/iu.exec(remoteUrl ?? "");
  if (scp) path = scp[1];
  else {
    let parsed;
    try { parsed = new URL(remoteUrl); }
    catch { throw new Error("origin must be a canonical GitHub origin URL"); }
    if (parsed.hostname.toLowerCase() !== "github.com") throw new Error("origin must be a GitHub origin URL");
    path = parsed.pathname.replace(/^\//u, "");
  }
  const repository = path.replace(/\.git$/iu, "");
  assertRepository(repository);
  if (repository.toLowerCase() !== expectedRepository.toLowerCase()) {
    throw new Error("origin does not match the expected repository");
  }
  return expectedRepository;
}

export function checkpointMaxGapMs(requiredDurationMs, minimumCount) {
  if (!Number.isFinite(requiredDurationMs) || requiredDurationMs <= 0
    || !Number.isSafeInteger(minimumCount) || minimumCount < 1) throw new Error("checkpoint cadence inputs are invalid");
  const base = Math.ceil(requiredDurationMs / minimumCount);
  return base + Math.max(5 * 60_000, Math.ceil(base * 0.5));
}

export function pendingGitHubCheckpointEvents(events, verifiedCount) {
  const committed = events.filter((event) => event?.type === "bounded_run_committed");
  if (!Number.isSafeInteger(verifiedCount) || verifiedCount < 0 || verifiedCount > committed.length) {
    throw new Error("verified GitHub checkpoint prefix exceeds local run evidence");
  }
  return committed.slice(verifiedCount);
}

export function assertGitHubCliAuthenticated(result) {
  if (!result || result.status !== 0) {
    const detail = String(result?.stderr ?? result?.error?.message ?? "GitHub CLI unavailable or unauthenticated").trim();
    throw new Error(`authenticated GitHub CLI access is required for production acceptance anchors: ${detail}`);
  }
}

export function canonicalGitHubAnchorBody(fields) {
  if (!fields || !new Set(["start", "checkpoint", "end"]).has(fields.kind)) throw new Error("anchor kind must be start, checkpoint, or end");
  const entries = Object.entries(fields).sort(([left], [right]) => left.localeCompare(right));
  return ["MartinLoop private overnight acceptance anchor v1", ...entries.map(([key, value]) => `${key}=${String(value)}`)].join("\n");
}

export function parseGitHubAnchorComment({ repository, issue, actor, expectedBody, comment }) {
  assertRepository(repository);
  if (!Number.isSafeInteger(issue) || issue < 1) throw new Error("anchor issue must be a positive integer");
  if (!actor || typeof actor.login !== "string" || !actor.login
    || !new Set(["OWNER", "MEMBER", "COLLABORATOR"]).has(actor.association)) {
    throw new Error("expected anchor actor and trusted association are required");
  }
  if (typeof expectedBody !== "string" || !expectedBody) throw new Error("expected anchor body is required");
  const expectedIssueUrl = `https://api.github.com/repos/${repository}/issues/${issue}`;
  if (!comment || !Number.isSafeInteger(comment.id) || comment.id < 1
    || comment.issue_url !== expectedIssueUrl
    || comment.html_url !== `https://github.com/${repository}/issues/${issue}#issuecomment-${comment.id}`
    || typeof comment.body !== "string" || comment.body !== expectedBody
    || typeof comment.created_at !== "string" || !Number.isFinite(Date.parse(comment.created_at))
    || typeof comment.updated_at !== "string" || comment.updated_at !== comment.created_at
    || comment.user?.login !== actor.login || comment.author_association !== actor.association) {
    throw new Error("GitHub anchor comment is missing, edited, or does not match the canonical body");
  }
  return {
    schemaVersion: "martin.overnight.github-anchor.v1",
    repository,
    issue,
    commentId: comment.id,
    htmlUrl: comment.html_url,
    bodySha256: sha256(expectedBody),
    createdAt: comment.created_at,
    userLogin: comment.user.login,
    actorAssociation: comment.author_association,
  };
}

export function verifyGitHubAnchorRecord({ record, repository, issue, actor, expectedBody, comment }) {
  const live = parseGitHubAnchorComment({ repository, issue, actor, expectedBody, comment });
  if (JSON.stringify(live) !== JSON.stringify(record)) {
    throw new Error("persisted GitHub anchor record does not match the live unedited comment");
  }
  return live;
}

export function assertGitHubCheckpointCadence({ start, checkpoints, end, minimumCount, maxGapMs }) {
  if (!Array.isArray(checkpoints) || checkpoints.length < minimumCount) {
    throw new Error("GitHub checkpoint anchor count is below the required qualifying run count");
  }
  if (!Number.isFinite(maxGapMs) || maxGapMs <= 0) throw new Error("GitHub checkpoint cadence bound is invalid");
  const ordered = [start, ...checkpoints, end];
  for (let index = 1; index < ordered.length; index += 1) {
    const gap = Date.parse(ordered[index]?.createdAt) - Date.parse(ordered[index - 1]?.createdAt);
    if (!Number.isFinite(gap) || gap < 0 || gap > maxGapMs) {
      throw new Error("GitHub checkpoint anchors are out of order or exceed the bounded cadence gap");
    }
  }
  return true;
}

export function assertGitHubServerElapsed(start, end, requiredDurationMs) {
  if (!Number.isFinite(requiredDurationMs) || requiredDurationMs <= 0) throw new Error("required anchor duration is invalid");
  const elapsedMs = Date.parse(end?.createdAt) - Date.parse(start?.createdAt);
  if (!Number.isFinite(elapsedMs) || elapsedMs < requiredDurationMs) {
    throw new Error("GitHub server anchor elapsed time is shorter than the required soak duration");
  }
  return elapsedMs;
}
