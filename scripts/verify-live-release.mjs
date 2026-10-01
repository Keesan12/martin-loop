// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export async function readReleaseMetadata() {
  return {
    root: JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")),
    mcp: JSON.parse(await readFile(new URL("../packages/mcp/package.json", import.meta.url), "utf8")),
    server: JSON.parse(await readFile(new URL("../packages/mcp/server.json", import.meta.url), "utf8")),
    mcpb: JSON.parse(await readFile(new URL("../packages/mcp/mcpb/manifest.json", import.meta.url), "utf8")),
  };
}

export function validateReleaseMetadata({ root, mcp, server, mcpb }) {
  assert.equal(root.version, mcp.version, "root and MCP package versions must match");
  assert.equal(server.version, mcp.version, "MCP server version must match package version");
  assert.equal(mcpb.version, mcp.version, "MCPB product version must match MCP package version");
  assert.equal(mcpb.manifest_version, "0.3", "MCPB manifest schema must remain 0.3");
  return {
    rootVersion: root.version,
    mcpVersion: mcp.version,
    rootTag: `v${root.version}`,
    mcpTag: `mcp-v${mcp.version}`,
  };
}

export async function verifyLiveRelease({
  fetchImpl = fetch,
  delayImpl = delay,
  repo = process.env.GITHUB_REPOSITORY ?? "Keesan12/martin-loop",
  githubToken = process.env.GITHUB_TOKEN ?? "",
  metadata,
  registryAttempts = 8,
} = {}) {
  const releaseMetadata = metadata ?? await readReleaseMetadata();
  const { root, mcp, server, mcpb } = releaseMetadata;
  const { rootVersion, mcpVersion, rootTag, mcpTag } = validateReleaseMetadata(releaseMetadata);

  function headersFor(url) {
    const parsed = new URL(url);
    const base = { "User-Agent": "martinloop-live-release-verifier" };
    if (parsed.hostname === "api.github.com") {
      return { ...base, Accept: "application/vnd.github+json", ...(githubToken ? { Authorization: `Bearer ${githubToken}` } : {}) };
    }
    if (parsed.hostname === "registry.npmjs.org" || parsed.hostname === "registry.modelcontextprotocol.io") {
      return { ...base, Accept: "application/json" };
    }
    return base;
  }
  async function fetchText(url) {
    const response = await fetchImpl(url, { headers: headersFor(url), redirect: "follow" });
    return { response, text: await response.text() };
  }
  async function getJson(url, label) {
    const { response, text } = await fetchText(url);
    if (!response.ok) throw new Error(`${label} failed: HTTP ${response.status}\n${text.slice(0, 1000)}`);
    return JSON.parse(text);
  }
  async function getJsonWith404Retries(url, label) {
    let lastStatus = 0;
    let lastText = "";
    for (let attempt = 1; attempt <= registryAttempts; attempt += 1) {
      const { response, text } = await fetchText(url);
      if (response.ok) return JSON.parse(text);
      lastStatus = response.status;
      lastText = text;
      if (response.status !== 404 || attempt === registryAttempts) break;
      await delayImpl(attempt * 5000);
    }
    throw new Error(`${label} failed after bounded retries: HTTP ${lastStatus}\n${lastText.slice(0, 1000)}`);
  }
  async function getText(url, label) {
    const { response, text } = await fetchText(url);
    if (!response.ok) throw new Error(`${label} failed: HTTP ${response.status}\n${text.slice(0, 1000)}`);
    return text;
  }
  async function getBytes(url, label) {
    const response = await fetchImpl(url, { headers: headersFor(url), redirect: "follow" });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!response.ok) throw new Error(`${label} failed: HTTP ${response.status}\n${bytes.toString("utf8", 0, Math.min(bytes.length, 1000))}`);
    return bytes;
  }

  const rootNpm = await getJson(`https://registry.npmjs.org/martin-loop/${rootVersion}`, "root npm version");
  assert.equal(rootNpm.name, "martin-loop");
  assert.equal(rootNpm.version, rootVersion);
  const rootNpmIndex = await getJson("https://registry.npmjs.org/martin-loop", "root npm index");
  assert.equal(rootNpmIndex["dist-tags"]?.latest, rootVersion, `martin-loop latest must be ${rootVersion}`);

  const mcpNpm = await getJson(`https://registry.npmjs.org/%40martinloop%2Fmcp/${mcpVersion}`, "MCP npm version");
  assert.equal(mcpNpm.name, "@martinloop/mcp");
  assert.equal(mcpNpm.version, mcpVersion);
  const mcpNpmIndex = await getJson("https://registry.npmjs.org/%40martinloop%2Fmcp", "MCP npm index");
  assert.equal(mcpNpmIndex["dist-tags"]?.latest, mcpVersion, `@martinloop/mcp latest must be ${mcpVersion}`);

  const [owner, repoName, ...extra] = repo.split("/");
  assert.ok(owner && repoName && extra.length === 0, "repo must be owner/name");
  const releaseBase = `https://api.github.com/repos/${owner}/${repoName}/releases/tags`;
  const rootRelease = await getJson(`${releaseBase}/${rootTag}`, "root GitHub release");
  assert.equal(rootRelease.tag_name, rootTag);
  assert.equal(rootRelease.draft, false);
  assert.equal(rootRelease.prerelease, false);
  const mcpRelease = await getJson(`${releaseBase}/${mcpTag}`, "MCP GitHub release");
  assert.equal(mcpRelease.tag_name, mcpTag);
  assert.equal(mcpRelease.draft, false);
  assert.equal(mcpRelease.prerelease, false);

  const expectedMcpb = `martinloop-${mcpVersion}.mcpb`;
  const expectedChecksum = `${expectedMcpb}.sha256`;
  const expectedRootTarball = `martin-loop-${rootVersion}.tgz`;
  const rootAssets = new Map(rootRelease.assets.map((asset) => [asset.name, asset]));
  assert.ok(rootAssets.has(expectedRootTarball), `root release must include ${expectedRootTarball}`);
  assert.ok(rootAssets.has(expectedMcpb), `root release must include ${expectedMcpb}`);
  assert.ok(rootAssets.has(expectedChecksum), `root release must include ${expectedChecksum}`);

  const mcpbAsset = rootAssets.get(expectedMcpb);
  const checksumAsset = rootAssets.get(expectedChecksum);
  const checksumText = await getText(checksumAsset.browser_download_url, "MCPB checksum asset");
  const expectedSha = checksumText.trim().split(/\s+/)[0]?.toLowerCase();
  assert.match(expectedSha ?? "", /^[a-f0-9]{64}$/, "MCPB checksum asset must contain a SHA-256 digest");
  const mcpbBytes = await getBytes(mcpbAsset.browser_download_url, "MCPB release asset");
  const actualSha = createHash("sha256").update(mcpbBytes).digest("hex");
  assert.equal(actualSha, expectedSha, "MCPB asset must match its published SHA-256 checksum");

  const encodedServer = encodeURIComponent(server.name);
  const registry = await getJsonWith404Retries(
    `https://registry.modelcontextprotocol.io/v0.1/servers/${encodedServer}/versions/${mcpVersion}`,
    "official MCP Registry listing",
  );
  return {
    verified: true,
    root: { package: root.name, version: rootVersion, latest: rootNpmIndex["dist-tags"].latest, tag: rootTag, releaseUrl: rootRelease.html_url, tarball: expectedRootTarball },
    mcp: { package: mcp.name, version: mcpVersion, latest: mcpNpmIndex["dist-tags"].latest, tag: mcpTag, releaseUrl: mcpRelease.html_url, registryName: server.name, registryVerified: Boolean(registry) },
    mcpb: { version: mcpVersion, manifestSchema: mcpb.manifest_version, asset: expectedMcpb, releaseUrl: mcpbAsset.browser_download_url, sha256: actualSha, size: mcpbBytes.length },
  };
}

const isCli = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isCli) console.log(JSON.stringify(await verifyLiveRelease(), null, 2));
