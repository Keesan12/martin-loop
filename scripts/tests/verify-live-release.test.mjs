import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readReleaseMetadata, validateReleaseMetadata, verifyLiveRelease } from "../verify-live-release.mjs";

function metadata(version = "9.8.7") {
  return {
    root: { name: "martin-loop", version },
    mcp: { name: "@martinloop/mcp", version },
    server: { name: "io.github.keesan12/martinloop", version },
    mcpb: { version, manifest_version: "0.3" },
  };
}

function response(body, status = 200) {
  return new Response(typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body), { status });
}

function successfulFetch(version = "9.8.7", registryResponses = [{ ok: true }]) {
  const bytes = Buffer.from("verified-mcpb");
  const sha = createHash("sha256").update(bytes).digest("hex");
  const assetUrl = "https://downloads.example/martinloop.mcpb";
  const checksumUrl = "https://downloads.example/martinloop.mcpb.sha256";
  const standaloneAssetUrl = "https://downloads.example/standalone/martinloop.mcpb";
  const standaloneChecksumUrl = "https://downloads.example/standalone/martinloop.mcpb.sha256";
  const seen = [];
  let registryIndex = 0;
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url === `https://registry.npmjs.org/martin-loop/${version}`) return response({ name: "martin-loop", version });
    if (url === "https://registry.npmjs.org/martin-loop") return response({ "dist-tags": { latest: version } });
    if (url === `https://registry.npmjs.org/%40martinloop%2Fmcp/${version}`) return response({ name: "@martinloop/mcp", version });
    if (url === "https://registry.npmjs.org/%40martinloop%2Fmcp") return response({ "dist-tags": { latest: version } });
    if (url.endsWith(`/releases/tags/v${version}`)) return response({ tag_name: `v${version}`, draft: false, prerelease: false, html_url: "https://example/root", assets: [
      { name: `martin-loop-${version}.tgz`, browser_download_url: "https://downloads.example/root.tgz" },
      { name: `martinloop-${version}.mcpb`, browser_download_url: assetUrl },
      { name: `martinloop-${version}.mcpb.sha256`, browser_download_url: checksumUrl },
    ] });
    if (url.endsWith(`/releases/tags/mcp-v${version}`)) return response({ tag_name: `mcp-v${version}`, draft: false, prerelease: false, html_url: "https://example/mcp", assets: [
      { name: `martinloop-${version}.mcpb`, browser_download_url: standaloneAssetUrl },
      { name: `martinloop-${version}.mcpb.sha256`, browser_download_url: standaloneChecksumUrl },
    ] });
    if (url === checksumUrl || url === standaloneChecksumUrl) return response(`${sha}  martinloop-${version}.mcpb\n`);
    if (url === assetUrl || url === standaloneAssetUrl) return response(bytes);
    if (url.startsWith("https://registry.modelcontextprotocol.io/")) {
      const item = registryResponses[Math.min(registryIndex, registryResponses.length - 1)];
      registryIndex += 1;
      return item.ok ? response(item) : response(item.body ?? "missing", item.status ?? 404);
    }
    throw new Error(`unexpected URL: ${url}`);
  };
  return { fetchImpl, seen, bytes };
}

test("current metadata derives the release version instead of pinning an old release", async () => {
  const current = await readReleaseMetadata();
  const coordinates = validateReleaseMetadata(current);
  assert.equal(coordinates.rootVersion, "0.6.9");
  assert.equal(coordinates.mcpVersion, "0.6.9");
  assert.equal(coordinates.rootTag, "v0.6.9");
  assert.equal(coordinates.mcpTag, "mcp-v0.6.9");
});

test("metadata coordinate mismatches fail closed", () => {
  const mismatched = metadata();
  mismatched.server.version = "0.0.0";
  assert.throws(() => validateReleaseMetadata(mismatched), /MCP server version must match/);
});

test("live verification uses the derived version and verifies the checksum", async () => {
  const mock = successfulFetch();
  const result = await verifyLiveRelease({ fetchImpl: mock.fetchImpl, metadata: metadata(), repo: "owner/repo" });
  assert.equal(result.verified, true);
  assert.equal(result.root.version, "9.8.7");
  assert.equal(result.mcpb.sha256, createHash("sha256").update(mock.bytes).digest("hex"));
  assert.ok(mock.seen.some((url) => url.endsWith("/releases/tags/v9.8.7")));
  assert.ok(mock.seen.some((url) => url.endsWith("/versions/9.8.7")));
});

test("stale npm latest fails", async () => {
  const mock = successfulFetch();
  const fetchImpl = async (url, options) => url === "https://registry.npmjs.org/martin-loop"
    ? response({ "dist-tags": { latest: "1.0.0" } })
    : mock.fetchImpl(url, options);
  await assert.rejects(() => verifyLiveRelease({ fetchImpl, metadata: metadata() }), /martin-loop latest must be 9\.8\.7/);
});

test("registry 404 retry is bounded and uses the injected delay", async () => {
  const mock = successfulFetch("9.8.7", [{ ok: false, status: 404 }, { ok: true }]);
  const delays = [];
  const result = await verifyLiveRelease({ fetchImpl: mock.fetchImpl, delayImpl: async (ms) => delays.push(ms), metadata: metadata(), registryAttempts: 2 });
  assert.equal(result.verified, true);
  assert.deepEqual(delays, [5000]);
});

test("MCPB checksum mismatch fails", async () => {
  const mock = successfulFetch();
  const fetchImpl = async (url, options) => url.endsWith(".sha256")
    ? response(`${"0".repeat(64)}  wrong.mcpb\n`)
    : mock.fetchImpl(url, options);
  await assert.rejects(() => verifyLiveRelease({ fetchImpl, metadata: metadata() }), /MCPB asset must match/);
});

test("standalone MCP release must include the MCPB and checksum assets", async () => {
  const mock = successfulFetch();
  const fetchImpl = async (url, options) => url.endsWith("/releases/tags/mcp-v9.8.7")
    ? response({ tag_name: "mcp-v9.8.7", draft: false, prerelease: false, html_url: "https://example/mcp", assets: [] })
    : mock.fetchImpl(url, options);

  await assert.rejects(
    () => verifyLiveRelease({ fetchImpl, metadata: metadata() }),
    /standalone MCP release must include martinloop-9\.8\.7\.mcpb/,
  );
});

test("standalone MCP release must include the MCPB checksum asset", async () => {
  const mock = successfulFetch();
  const fetchImpl = async (url, options) => url.endsWith("/releases/tags/mcp-v9.8.7")
    ? response({
      tag_name: "mcp-v9.8.7",
      draft: false,
      prerelease: false,
      html_url: "https://example/mcp",
      assets: [{ name: "martinloop-9.8.7.mcpb", browser_download_url: "https://downloads.example/standalone/martinloop.mcpb" }],
    })
    : mock.fetchImpl(url, options);

  await assert.rejects(
    () => verifyLiveRelease({ fetchImpl, metadata: metadata() }),
    /standalone MCP release must include martinloop-9\.8\.7\.mcpb\.sha256/,
  );
});

test("standalone MCP release checksum must match its MCPB asset", async () => {
  const mock = successfulFetch();
  const fetchImpl = async (url, options) => url === "https://downloads.example/standalone/martinloop.mcpb.sha256"
    ? response(`${"0".repeat(64)}  martinloop-9.8.7.mcpb\n`)
    : mock.fetchImpl(url, options);

  await assert.rejects(
    () => verifyLiveRelease({ fetchImpl, metadata: metadata() }),
    /standalone MCP release MCPB asset must match its published SHA-256 checksum/,
  );
});
