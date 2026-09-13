// SPDX-License-Identifier: Apache-2.0
import { assertInfrastructureRetryEvidence } from "./lib/release-retry-evidence.mjs";
function arg(name) { const index = process.argv.indexOf(name); return index === -1 ? undefined : process.argv[index + 1]; }
const runId = arg("--run-id");
const candidateSha = arg("--candidate-sha");
const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN;
if (!/^\d+$/u.test(runId ?? "") || !repository || !token) { console.error("retry verification requires --run-id, --candidate-sha, GITHUB_REPOSITORY, and GH_TOKEN"); process.exit(2); }
async function github(path) {
  const response = await fetch(`https://api.github.com/repos/${repository}${path}`, { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" } });
  if (!response.ok) throw new Error(`GitHub API ${path} returned ${response.status}`);
  return response.json();
}
const run = await github(`/actions/runs/${runId}`);
const jobs = await github(`/actions/runs/${runId}/jobs?per_page=100`);
const result = assertInfrastructureRetryEvidence({ run, jobs: jobs.jobs, candidateSha });
console.log(`[release-retry] PASS classification=${result.classification} priorRunId=${result.runId}`);
