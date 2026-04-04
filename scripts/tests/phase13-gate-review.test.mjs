import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  createPhase13GateReviewReport,
  renderPhase13GateReviewMarkdown,
} from "../phase13-gate-review.mjs";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("createPhase13GateReviewReport stays honest about the remaining macOS and Linux evidence gap", async () => {
  const report = await createPhase13GateReviewReport({ rootDir: ROOT_DIR });

  assert.equal(report.gates.ossBoundary, true);
  assert.equal(report.gates.releaseSurface, true);
  assert.equal(report.gates.pilotPrep, true);
  assert.equal(report.osEvidence.windows.status, "passed");
  assert.equal(report.osEvidence.macos.status, "missing");
  assert.equal(report.osEvidence.linux.status, "missing");
  assert.equal(report.verdict, "no_go");
  assert.ok(report.blockers.some((entry) => /macOS/i.test(entry)));
  assert.ok(report.blockers.some((entry) => /Linux/i.test(entry)));
});

test("renderPhase13GateReviewMarkdown produces a reviewer-ready gate summary", async () => {
  const report = await createPhase13GateReviewReport({ rootDir: ROOT_DIR });
  const markdown = renderPhase13GateReviewMarkdown(report);

  assert.match(markdown, /^# Martin Loop Phase 13 Gate Review/m);
  assert.match(markdown, /NO_GO/);
  assert.match(markdown, /windows/i);
  assert.match(markdown, /macos/i);
  assert.match(markdown, /linux/i);
  assert.match(markdown, /pilot-prep audit/i);
});
