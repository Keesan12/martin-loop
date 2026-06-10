import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  REQUIRED_CTA_CHECKS,
  checkReadmePrecedenceHazards,
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
**Get started:** \`npx -y martin-loop@latest start\`
`;
  const result = evaluateReadmeCtaGuards(incompleteReadme);

  assert.equal(result.ok, false);
  assert.ok(result.missingChecks.length > 0);
  assert.ok(result.missingChecks.length < REQUIRED_CTA_CHECKS.length);
  assert.ok(result.missingChecks.some((missing) => missing.id === "top_demo_cta"));
  assert.ok(result.missingChecks.some((missing) => missing.id === "nvidia_marker"));
});

test("README CTA guard blocks .github README shadowing", async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), "readme-cta-guard-"));
  await writeFile(path.join(tempRoot, "README.md"), "# MartinLoop\n", "utf8");
  await mkdir(path.join(tempRoot, ".github"), { recursive: true });
  await writeFile(path.join(tempRoot, ".github", "README.md"), "# Workflow docs\n", "utf8");

  const hazards = await checkReadmePrecedenceHazards(tempRoot);

  assert.equal(hazards.length, 1);
  assert.equal(hazards[0].id, "github_readme_shadow");
});
