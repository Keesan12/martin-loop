import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("verification-only entrypoints disclose the governed evidence boundary", async () => {
  const cli = await readFile("packages/cli/src/index.ts", "utf8");
  const mcp = await readFile("packages/mcp/src/tools/run-loop.ts", "utf8");

  assert.match(cli, /cannot emit governed VERIFIED/u);
  assert.match(mcp, /governanceClaimEligible/u);
  assert.match(mcp, /verification_only/u);
});
