import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  REQUIRED_CTA_CHECKS,
  evaluateReadmeCtaGuards,
  readRootReadme,
} from "../readme-cta-guard.mjs";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("README CTA guard passes for the public README", async () => {
  const readme = await readRootReadme(ROOT_DIR);
  const result = evaluateReadmeCtaGuards(readme);

  assert.equal(result.ok, true);
  assert.deepEqual(result.missingChecks, []);
});

test("README CTA guard reports missing anchors", () => {
  const incompleteReadme = `
# MartinLoop
**Star this repo:** [GitHub stars](https://github.com/Keesan12/martin-loop)
`;
  const result = evaluateReadmeCtaGuards(incompleteReadme);

  assert.equal(result.ok, false);
  assert.ok(result.missingChecks.length > 0);
  assert.ok(result.missingChecks.length < REQUIRED_CTA_CHECKS.length);
  assert.ok(result.missingChecks.some((missing) => missing.id === "top_try_now_cta"));
  assert.ok(result.missingChecks.some((missing) => missing.id === "footer_star_cta"));
  assert.ok(result.missingChecks.some((missing) => missing.id === "nvidia_marker"));
});
