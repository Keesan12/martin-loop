#!/usr/bin/env node

import { Buffer } from "node:buffer";
import { readFile, writeFile } from "node:fs/promises";

const VERSION = "0.6.1";
const LIVE_VERSION = "0.6.0";
const privateMainSha = process.env.PRIVATE_MAIN_SHA;
const publicBaseSha = process.env.PUBLIC_BASE_SHA;
const validatedAt = process.env.VALIDATED_AT;

if (!/^[0-9a-f]{40}$/u.test(privateMainSha ?? "")) {
  throw new Error("PRIVATE_MAIN_SHA must be a full validated private main SHA");
}
if (!/^[0-9a-f]{40}$/u.test(publicBaseSha ?? "")) {
  throw new Error("PUBLIC_BASE_SHA must be a full public base SHA");
}
if (!validatedAt || Number.isNaN(Date.parse(validatedAt))) {
  throw new Error("VALIDATED_AT must be a valid ISO timestamp");
}

async function read(path) {
  return readFile(path, "utf8");
}
async function write(path, content) {
  await writeFile(path, content.endsWith("\n") ? content : `${content}\n`, "utf8");
}
async function readJson(path) {
  return JSON.parse(await read(path));
}
async function writeJson(path, value) {
  await write(path, JSON.stringify(value, null, 2));
}
function replaceRequired(text, from, to, label = from) {
  if (!text.includes(from)) throw new Error(`Missing expected ${label}`);
  return text.replace(from, to);
}

for (const path of ["package.json", "packages/cli/package.json", "packages/mcp/package.json"]) {
  const manifest = await readJson(path);
  manifest.version = VERSION;
  await writeJson(path, manifest);
}

const server = await readJson("packages/mcp/server.json");
server.version = VERSION;
const npmPackage = server.packages?.find((entry) => entry?.registryType === "npm");
if (!npmPackage) throw new Error("packages/mcp/server.json missing npm package entry");
npmPackage.version = VERSION;
await writeJson("packages/mcp/server.json", server);

const mcpb = await readJson("packages/mcp/mcpb/manifest.json");
mcpb.version = VERSION;
await writeJson("packages/mcp/mcpb/manifest.json", mcpb);

for (const path of [
  "plugins/martinloop/plugin.json",
  "plugins/martinloop/.claude-plugin/plugin.json",
  "plugins/martinloop/.codex-plugin/plugin.json",
]) {
  const manifest = await readJson(path);
  manifest.version = VERSION;
  await writeJson(path, manifest);
}

const pluginMcp = await readJson("plugins/martinloop/.mcp.json");
for (const config of Object.values(pluginMcp.mcpServers ?? {})) {
  if (!config || !Array.isArray(config.args)) continue;
  config.args = config.args.map((arg) =>
    typeof arg === "string" && arg.startsWith("@martinloop/mcp@")
      ? `@martinloop/mcp@${VERSION}`
      : arg,
  );
}
await writeJson("plugins/martinloop/.mcp.json", pluginMcp);

let runtimeVersion = await read("packages/mcp/src/package-version.ts");
runtimeVersion = runtimeVersion.replace(
  /MARTIN_MCP_PACKAGE_VERSION = "[^"]+";/u,
  `MARTIN_MCP_PACKAGE_VERSION = "${VERSION}";`,
);
await write("packages/mcp/src/package-version.ts", runtimeVersion);

const truth = await readJson("docs/product-truth/public-release-truth.json");
truth.cliVersion = VERSION;
truth.mcpVersion = VERSION;
await writeJson("docs/product-truth/public-release-truth.json", truth);

await writeJson(".martin/promotion-manifest.json", {
  schemaVersion: "martin.public-promotion.v1",
  privateRepository: "martin-Loop/ML_Core_OSS_Internal",
  privateMergeSha: privateMainSha,
  privateMainShaValidated: privateMainSha,
  publicBaseSha,
  promotedBy: "ChatGPT",
  validatedAt,
  internalHealthPassed: true,
});

let changelog = await read("CHANGELOG.md");
if (!changelog.includes(`## [${VERSION}]`)) {
  const entry = `## [${VERSION}] - 2026-09-07\n\n### Fixed\n- Made OpenAI-compatible models perform real governed workspace edits before verification instead of behaving as inference-only transports.\n- Rejected malformed, no-op, path-traversal, duplicate-path, denied-path, and symlink-escape edit plans before accepted work.\n\n### Changed\n- Added an explicit model-support contract for native Codex, Claude Code, Gemini CLI, and compatible hosted or local model endpoints.\n- Kept MartinLoop's budget, scope, verifier, receipt, and integrity contract independent of the coding worker.\n\n`;
  changelog = replaceRequired(
    changelog,
    "## [Unreleased]\n\n",
    `## [Unreleased]\n\n${entry}`,
    "CHANGELOG Unreleased heading",
  );
  await write("CHANGELOG.md", changelog);
}

let readme = await read("README.md");
readme = replaceRequired(
  readme,
  "Release notes for MartinLoop 0.6.0: [MartinLoop 0.6.0](./docs/release/OSS-0.6.0-RELEASE-NOTES.md).",
  "Release notes for MartinLoop 0.6.1: [MartinLoop 0.6.1](./docs/release/OSS-0.6.1-RELEASE-NOTES.md).",
  "README release notes pointer",
);
readme = readme.replaceAll("martin-loop@0.6.0", "martin-loop@0.6.1");
readme = readme.replaceAll("@martinloop/mcp@0.6.0", "@martinloop/mcp@0.6.1");
readme = readme.replace("aligned at `0.6.0`", "aligned at `0.6.1`");
if (!readme.includes("## Model and Engine Support")) {
  const marker = "## The Run From Start to Handoff";
  const support = `## Model and Engine Support\n\nMartinLoop governs the job independently of the coding worker.\n\n- Native agent CLIs: Codex, Claude Code, Gemini CLI\n- OpenAI-compatible endpoints: Kimi K2, NVIDIA Nemotron, DeepSeek, Qwen/Qwen Coder, Mistral/Codestral, OpenRouter/Together/Fireworks routes, Ollama, LM Studio, llama.cpp, and other compatible endpoints\n- Use \`--engine openai\` for OpenAI-compatible model endpoints.\n\nThe worker changes; MartinLoop's budget, scope, verifier, receipt, and integrity contract does not.\n\nMore detail: [Model and engine support](./docs/reference/model-support.md)\n\n`;
  readme = replaceRequired(readme, marker, `${support}${marker}`, "README run-flow heading");
}

const mcpConfig = { command: "npx", args: ["-y", `@martinloop/mcp@${VERSION}`] };
const cursorConfig = Buffer.from(JSON.stringify(mcpConfig), "utf8").toString("base64");
const cursorParams = new URLSearchParams({ name: "martin-loop", config: cursorConfig });
const vscodePayload = encodeURIComponent(JSON.stringify({ name: "martin-loop", ...mcpConfig }));
const installBlock = [
  "<!-- Generated by scripts/generate-install-links.mjs. -->",
  `<!-- MCP package: @martinloop/mcp@${VERSION} -->`,
  "",
  `[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_MartinLoop-007ACC?logo=visualstudiocode&logoColor=white)](vscode:mcp/install?${vscodePayload})`,
  `[![Add to Cursor](https://img.shields.io/badge/Cursor-Add_MartinLoop-111111)](cursor://anysphere.cursor-deeplink/mcp/install?${cursorParams.toString()})`,
  "",
].join("\n");
const installRegex = /<!-- Generated by scripts\/generate-install-links\.mjs\. -->[\s\S]*?\[!\[Add to Cursor\]\([^\n]+\)\n/u;
if (!installRegex.test(readme)) throw new Error("README install-link block not found");
readme = readme.replace(installRegex, installBlock);
await write("README.md", readme);

let ledger = await read("docs/release/VERSION-LEDGER.md");
ledger = replaceRequired(
  ledger,
  `- current in-repo root release: \`${LIVE_VERSION}\` (published)`,
  `- current in-repo root release target: \`${VERSION}\` (pending publication)`,
  "root current release row",
);
ledger = replaceRequired(
  ledger,
  `- current in-repo standalone release: \`${LIVE_VERSION}\` (published)`,
  `- current in-repo standalone release target: \`${VERSION}\` (pending publication)`,
  "MCP current release row",
);
ledger = replaceRequired(
  ledger,
  `- current in-repo MCPB release: \`${LIVE_VERSION}\` with manifest schema \`0.3\` (published)`,
  `- current in-repo MCPB release target: \`${VERSION}\` with manifest schema \`0.3\` (pending publication)`,
  "MCPB current release row",
);
ledger = replaceRequired(
  ledger,
  `- The \`${LIVE_VERSION}\` train aligns the root package, standalone MCP package, plugin metadata, and MCPB product version at \`${LIVE_VERSION}\`.`,
  `- The \`${VERSION}\` train aligns the root package, standalone MCP package, plugin metadata, and MCPB product version at \`${VERSION}\`.`,
  "release train rule",
);
await write("docs/release/VERSION-LEDGER.md", ledger);

let releaseDocsTest = await read("scripts/tests/mcp-release-docs.test.mjs");
const pendingStart = 'test("version ledger records the published release as live public truth", async () => {';
const nextTest = 'test("MCP slice map defines the 0.3.x train without private-hosted bleed", async () => {';
const start = releaseDocsTest.indexOf(pendingStart);
const end = releaseDocsTest.indexOf(nextTest);
if (start < 0 || end <= start) throw new Error("Could not locate version-ledger release-doc test block");
const pendingTest = `test("version ledger separates live public truth from the pending release target", async () => {\n  const ledger = await readRepoFile(path.join("docs", "release", "VERSION-LEDGER.md"));\n\n  assert.match(ledger, new RegExp(escapeRegex("live npm dist-tag \\`latest\\`: \\`${LIVE_VERSION}\\`")));\n  assert.match(ledger, new RegExp(escapeRegex("live public GitHub release: \\`v${LIVE_VERSION}\\`")));\n  assert.match(ledger, new RegExp(escapeRegex("live public GitHub release: \\`mcp-v${LIVE_VERSION}\\`")));\n  assert.match(ledger, new RegExp(escapeRegex("root public baseline: \\`${LIVE_VERSION}\\`")));\n  assert.match(ledger, new RegExp(escapeRegex("standalone MCP public baseline: \\`${LIVE_VERSION}\\`")));\n  assert.match(ledger, new RegExp(escapeRegex("current in-repo root release target: \\`${VERSION}\\` (pending publication)")));\n  assert.match(ledger, new RegExp(escapeRegex("current in-repo standalone release target: \\`${VERSION}\\` (pending publication)")));\n  assert.match(ledger, new RegExp(escapeRegex("current in-repo MCPB release target: \\`${VERSION}\\` with manifest schema \\`0.3\\` (pending publication)")));\n});\n\n`;
releaseDocsTest = `${releaseDocsTest.slice(0, start)}${pendingTest}${releaseDocsTest.slice(end)}`;
await write("scripts/tests/mcp-release-docs.test.mjs", releaseDocsTest);

await write(
  "docs/release/OSS-0.6.1-RELEASE-NOTES.md",
  `# MartinLoop 0.6.1\n\nMartinLoop 0.6.1 makes model-agnostic coding execution real. Native coding CLIs and OpenAI-compatible model endpoints now feed the same governed execution, verification, receipt, and integrity pipeline.\n\n## What changed\n\n- OpenAI-compatible models can return a constrained structured edit plan that MartinLoop validates and applies before verification.\n- Kimi K2, NVIDIA Nemotron, DeepSeek, Qwen, Mistral/Codestral, OpenRouter/Together/Fireworks routes, Ollama, LM Studio, llama.cpp, and other compatible endpoints can participate as governed coding workers through the existing \`openai\` engine.\n- Native Codex, Claude Code, and Gemini CLI execution remains unchanged.\n- Every proposed path is checked against repository boundaries and MartinLoop allow/deny scope before any write.\n- Path traversal, absolute paths, duplicate targets, malformed responses, no-op success claims, denied paths, and symlink escapes fail before accepted work.\n- The normal independent verifier still decides whether the resulting workspace satisfies the job contract.\n\n## Install\n\n\`\`\`sh\nnpx -y martin-loop@0.6.1 --version\nnpx -y martin-loop@0.6.1 doctor --engine openai\nnpx -y @martinloop/mcp@0.6.1\n\`\`\`\n`,
);

await write(
  "docs/release/MCP-0.6.1-RELEASE-NOTES.md",
  `# @martinloop/mcp 0.6.1\n\nThe 0.6.1 MCP package stays aligned with the MartinLoop 0.6.1 model-agnostic execution contract.\n\n## What changed\n\n- Package, server, runtime, plugin, and MCPB product versions align at 0.6.1.\n- Existing MCP tools and supported host contracts remain unchanged.\n- Model-agnostic worker execution is implemented in the shared MartinLoop adapter layer.\n- MCPB manifest schema remains 0.3.\n\n\`\`\`sh\nnpx -y @martinloop/mcp@0.6.1\n\`\`\`\n`,
);

await write(
  "docs/release/0.6.1-PUBLIC-PROMOTION.md",
  `# MartinLoop 0.6.1 Public Promotion\n\nThis public staging branch promotes the reviewed 0.6.1 model-agnostic runtime from the validated private source of truth while preserving public-only packaging and dependency fixes.\n\n## Customer-facing changes\n\n- OpenAI-compatible models now perform governed workspace edits before independent verification.\n- Native Codex, Claude Code, and Gemini CLI workers retain their existing execution paths.\n- Kimi K2, Nemotron, DeepSeek, Qwen, Mistral/Codestral, compatible hosted routes, and local model servers use the common \`openai\` engine contract.\n- Model-proposed paths are validated before writes; denied paths, traversal, malformed/no-op plans, duplicates, and symlink escapes fail closed.\n- README and reference docs make the cross-worker support contract explicit.\n\n## Release provenance\n\n- Private validated merge: \`${privateMainSha}\`\n- Public base: \`${publicBaseSha}\`\n- Root target: \`martin-loop@0.6.1\`\n- MCP target: \`@martinloop/mcp@0.6.1\`\n- Hard minimum-version enforcement remains disabled.\n- \`min-supported\` is not advanced.\n`,
);

process.stdout.write(`Prepared public MartinLoop ${VERSION} from ${privateMainSha}.\n`);
