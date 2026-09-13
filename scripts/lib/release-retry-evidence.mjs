// SPDX-License-Identifier: Apache-2.0
const INFRASTRUCTURE_CONCLUSIONS = new Set(["action_required", "cancelled", "stale", "startup_failure", "timed_out"]);

export function assertInfrastructureRetryEvidence({ run, jobs, candidateSha }) {
  const candidate = candidateSha?.toLowerCase();
  if (!/^[a-f0-9]{40}$/u.test(candidate ?? "")) throw new Error("candidate SHA must be a full Git SHA");
  if (run?.head_sha?.toLowerCase() !== candidate) throw new Error("prior run was not bound to the validated candidate SHA");
  if (!String(run?.path ?? "").endsWith(".github/workflows/cut-release-tags.yml")) throw new Error("prior run did not originate from the release controller");
  if ((jobs ?? []).some((job) => (job.steps ?? []).some((step) => step.conclusion === "failure"))) throw new Error("prior run contains a failed workflow step and is not classified as infrastructure");
  if (INFRASTRUCTURE_CONCLUSIONS.has(run.conclusion)) return { classification: "infrastructure", runId: run.id };
  if (run.conclusion !== "failure") throw new Error(`prior run conclusion ${run.conclusion ?? "missing"} is not retryable`);
  const failedJobs = (jobs ?? []).filter((job) => job.conclusion === "failure");
  if (failedJobs.length === 0) {
    throw new Error("prior failure contains a failed workflow step and is not classified as infrastructure");
  }
  return { classification: "infrastructure", runId: run.id };
}
