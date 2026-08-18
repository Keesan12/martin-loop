import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const productionEntrypoints = [
  "packages/cli/src/index.ts",
  "packages/mcp/src/tools/run-loop.ts",
];

test("production run entrypoints cannot construct the stub adapter", async () => {
  for (const file of productionEntrypoints) {
    const source = await readFile(file, "utf8");
    assert.doesNotMatch(source, /createStubDirectProviderAdapter/u, file);
  }
});

test("public adapter sources and exports contain no stub implementations", async () => {
  for (const file of [
    "packages/adapters/src/stub-agent-cli.ts",
    "packages/adapters/src/stub-direct-provider.ts",
  ]) {
    await assert.rejects(access(file), undefined, file);
  }

  const adapterIndex = await readFile("packages/adapters/src/index.ts", "utf8");
  assert.doesNotMatch(adapterIndex, /createStub(?:AgentCli|DirectProvider)Adapter/u);
});

test("verification-only entrypoints disclose the governed evidence boundary", async () => {
  const cli = await readFile("packages/cli/src/index.ts", "utf8");
  const mcp = await readFile("packages/mcp/src/tools/run-loop.ts", "utf8");

  assert.match(cli, /cannot emit governed VERIFIED/u);
  assert.match(mcp, /governanceClaimEligible/u);
  assert.match(mcp, /verification_only/u);
});
