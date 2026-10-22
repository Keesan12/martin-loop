import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("continuation review contracts", () => {
  it("blocks non-governed persisted runs before live adapter construction", async () => {
    const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
    const start = source.indexOf("async function executeContinueRunCommand");
    const guard = source.indexOf('detail.loop.metadata["executionMode"] !== "governed"', start);
    const adapter = source.indexOf("const adapter = selectAdapter(", start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(guard).toBeGreaterThan(start);
    expect(adapter).toBeGreaterThan(guard);
  });

  it("finalizes continued-run evidence before hosted sync", async () => {
    const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
    const start = source.indexOf("async function executeContinueRunCommand");
    const finalize = source.indexOf("await finalizeContinuationEvidence(", start);
    const sync = source.indexOf("await enqueueLoopForHostedSync(", start);

    expect(finalize).toBeGreaterThan(start);
    expect(sync).toBeGreaterThan(finalize);
  });
});
