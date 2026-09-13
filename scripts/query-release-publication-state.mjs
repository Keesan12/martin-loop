// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
function arg(name) { const index = process.argv.indexOf(name); return index === -1 ? undefined : process.argv[index + 1]; }
const version = arg("--version");
const output = resolve(arg("--output") ?? ".martin/release-publication-state.json");
const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version ?? "") || !repository || !token) { console.error("publication-state query requires --version, GITHUB_REPOSITORY, and GH_TOKEN"); process.exit(2); }
async function exists(url, headers = {}) {
  const response = await fetch(url, { headers });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return true;
}
const githubHeaders = { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`, "X-GitHub-Api-Version": "2022-11-28" };
const [rootNpmPublished, mcpNpmPublished, rootGithubReleaseExists, mcpGithubReleaseExists] = await Promise.all([
  exists(`https://registry.npmjs.org/martin-loop/${version}`),
  exists(`https://registry.npmjs.org/%40martinloop%2Fmcp/${version}`),
  exists(`https://api.github.com/repos/${repository}/releases/tags/v${version}`, githubHeaders),
  exists(`https://api.github.com/repos/${repository}/releases/tags/mcp-v${version}`, githubHeaders),
]);
const state = { schemaVersion: "martin.release-publication-state.v1", version, checkedAt: new Date().toISOString(), rootNpmPublished, mcpNpmPublished, rootGithubReleaseExists, mcpGithubReleaseExists };
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${JSON.stringify(state, null, 2)}\n`);
console.log(`[release-publication-state] PASS version=${version} root=${rootNpmPublished || rootGithubReleaseExists} mcp=${mcpNpmPublished || mcpGithubReleaseExists}`);
