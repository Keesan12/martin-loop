import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("continuation review contracts", () => {
  it("blocks non-governed persisted runs before live adapter construction", async () => {
    const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
    const continueStart = source.indexOf("async function executeContinueRunCommand");
    const guard = source.indexOf('detail.loop.metadata["executionMode"] !== "governed"', continueStart);
    const adapter = source.indexOf("const adapter = selectAdapter(", continueStart);

    expect(continueStart).toBeGreaterThanOrEqual(0);
    expect(guard).toBeGreaterThan(continueStart);
    expect(adapter).toBeGreaterThan(guard);
  });

  it("finalizes canonical continued-run evidence before hosted sync", async () => {
    const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
    const continueStart = source.indexOf("async function executeContinueRunCommand");
    const finalize = source.indexOf("await finalizeContinuationEvidence(", continueStart);
    const sync = source.indexOf("await enqueueLoopForHostedSync(", continueStart);

    expect(finalize).toBeGreaterThan(continueStart);
    expect(sync).toBeGreaterThan(finalize);
  });
});
