import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  readControlReceipts,
  readRunControlApplications,
  resolveRunControlSnapshot,
  hashCanonical
} from "../src/tools/run-controls.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function writeControls(contents: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "martin-mcp-controls-integrity-"));
  roots.push(root);
  const receiptPath = path.join(root, "controls.jsonl");
  await writeFile(receiptPath, contents, "utf8");
  return receiptPath;
}

function receipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const unsigned = {
    schemaVersion: "martin.run-control.v2",
    controlId: "ctl_test_001",
    loopId: "loop_expected",
    action: "cancel",
    requestedAt: "2026-10-29T12:00:00.000Z",
    authorityBoundary: "local_os_user",
    principal: "local_mcp_client",
    executorLeaseToken: "test-lease-token",
    ...overrides
  };
  return { ...unsigned, receiptHash: hashCanonical(unsigned) };
}

function expectIntegrityFailure(promise: Promise<unknown>) {
  return expect(promise).rejects.toMatchObject({
    code: "store_unreadable",
    category: "store_unreadable",
    message: "Run control receipt integrity check failed."
  });
}

describe("run control receipt integrity", () => {
  it("fails closed when a valid cancellation is followed by malformed JSON", async () => {
    const receiptPath = await writeControls(`${JSON.stringify(receipt())}\n{not-json}\n`);

    await expectIntegrityFailure(readControlReceipts(receiptPath, "loop_expected"));
  });

  it("fails closed when a receipt uses an unknown action", async () => {
    const receiptPath = await writeControls(
      `${JSON.stringify(receipt({ action: "terminate_everything" }))}\n`
    );

    await expectIntegrityFailure(readControlReceipts(receiptPath, "loop_expected"));
  });

  it("fails closed when a receipt belongs to another loop", async () => {
    const receiptPath = await writeControls(
      `${JSON.stringify(receipt({ loopId: "loop_other" }))}\n`
    );

    await expectIntegrityFailure(readControlReceipts(receiptPath, "loop_expected"));
  });

  it("fails closed on a partially appended receipt", async () => {
    const receiptPath = await writeControls(
      `${JSON.stringify(receipt())}\n{\"controlId\":\"ctl_partial\",\"loopId\":\"loop_expected\"`
    );

    await expectIntegrityFailure(readControlReceipts(receiptPath, "loop_expected"));
  });

  it("returns validated receipts for the selected loop", async () => {
    const first = receipt({ action: "pause" });
    const second = receipt({
      controlId: "ctl_test_002",
      action: "continue",
      expectedPreviousControlId: "ctl_test_001",
      previousReceiptHash: first.receiptHash,
      requestedAt: "2026-10-29T12:01:00.000Z"
    });
    const receiptPath = await writeControls(
      `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`
    );

    await expect(readControlReceipts(receiptPath, "loop_expected")).resolves.toEqual([
      first,
      second
    ]);
  });

  it("fails closed when a receipt payload no longer matches its hash", async () => {
    const sealed = receipt();
    const receiptPath = await writeControls(
      `${JSON.stringify({ ...sealed, reason: "tampered after sealing" })}\n`
    );

    await expectIntegrityFailure(readControlReceipts(receiptPath, "loop_expected"));
  });

  it("fails closed on an extra caller-supplied identity claim even when it is re-sealed", async () => {
    const receiptPath = await writeControls(
      `${JSON.stringify(receipt({ requestedBy: "admin" }))}\n`
    );

    await expectIntegrityFailure(readControlReceipts(receiptPath, "loop_expected"));
  });

  it("fails closed when the receipt hash chain skips its predecessor", async () => {
    const first = receipt({ action: "pause" });
    const second = receipt({
      controlId: "ctl_test_002",
      action: "continue",
      expectedPreviousControlId: "ctl_test_001",
      previousReceiptHash: "0".repeat(64),
      requestedAt: "2026-10-29T12:01:00.000Z"
    });
    const receiptPath = await writeControls(`${JSON.stringify(first)}\n${JSON.stringify(second)}\n`);

    await expectIntegrityFailure(readControlReceipts(receiptPath, "loop_expected"));
  });

  it("fails closed when continue is not bound to the pending pause", () => {
    const pause = receipt({ action: "pause" });
    const staleContinue = receipt({
      controlId: "ctl_stale_continue",
      action: "continue",
      expectedPreviousControlId: "ctl_other_pause",
      requestedAt: "2026-10-29T12:01:00.000Z"
    });

    expect(() => resolveRunControlSnapshot([pause, staleContinue])).toThrow(
      "Run control receipt integrity check failed."
    );
  });

  it("fails closed when control identities are reused across the receipt graph", () => {
    const firstPause = receipt({ action: "pause" });
    const continued = receipt({
      controlId: "ctl_continue",
      action: "continue",
      expectedPreviousControlId: "ctl_test_001",
      requestedAt: "2026-10-29T12:01:00.000Z"
    });
    const reusedPause = receipt({
      action: "pause",
      requestedAt: "2026-10-29T12:02:00.000Z"
    });

    expect(() => resolveRunControlSnapshot([firstPause, continued, reusedPause])).toThrow(
      "Run control receipt integrity check failed."
    );
  });

  it("fails closed on a partially appended application record", async () => {
    const applicationPath = await writeControls(
      '{"loopId":"loop_expected","controlId":"ctl_test_001","action":"pause_applied"'
    );

    await expectIntegrityFailure(
      readRunControlApplications(applicationPath, "loop_expected")
    );
  });
});
