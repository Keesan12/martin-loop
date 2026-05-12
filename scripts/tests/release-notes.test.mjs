import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  generateReleaseNotes,
  loadReleaseNotesConfig,
  resolvePreviousTag
} from "../generate-release-notes.mjs";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("resolvePreviousTag finds the prior semver tag for a release", () => {
  const previous = resolvePreviousTag(["v0.1.0", "v0.1.3", "v0.1.4", "v0.1.5", "v1.2.0"], "v0.1.4");
  assert.equal(previous, "v0.1.3");
});

test("generateReleaseNotes renders the compare range, challenge link, and discussion links", async () => {
  const config = await loadReleaseNotesConfig();
  const result = await generateReleaseNotes({
    rootDir: ROOT_DIR,
    currentTag: "v0.1.4",
    previousTag: "v0.1.3",
    config
  });

  assert.equal(result.compareRange, "v0.1.3...v0.1.4");
  assert.match(result.notes, /## What changed since v0\.1\.3/);
  assert.match(result.notes, /https:\/\/github\.com\/Keesan12\/martin-loop\/blob\/main\/docs\/distribution\/UNDER-3-CHALLENGE\.md/);
  assert.match(result.notes, /https:\/\/github\.com\/Keesan12\/martin-loop\/discussions\/26/);
  assert.match(result.notes, /\*\*Full Changelog\*\*: https:\/\/github\.com\/Keesan12\/martin-loop\/compare\/v0\.1\.3\.\.\.v0\.1\.4/);
});
