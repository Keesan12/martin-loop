import test from "node:test";
import assert from "node:assert/strict";

import {
  findSubjectViolations,
  parseCommitSubjectLog,
} from "../public-git-surface-guard.mjs";

test("public git surface guard accepts client-facing commit subjects", () => {
  const violations = findSubjectViolations([
    {
      sha: "3b330fab725f",
      subject: "Clarify MartinLoop OSS package presentation",
    },
    {
      sha: "f3e42e756afd",
      subject: "Ship branded @martinloop/mcp package metadata",
    },
  ]);

  assert.deepEqual(violations, []);
});

test("public git surface guard rejects internal-process commit subjects", () => {
  const violations = findSubjectViolations([
    {
      sha: "f97e71aabbb9",
      subject: "chore: snapshot phase 13 rc state for ci",
    },
    {
      sha: "111111111111",
      subject: "docs: update internal handoff for staging_repo_Internal",
    },
    {
      sha: "222222222222",
      subject: "docs: clean public repo surface",
    },
    {
      sha: "333333333333",
      subject: "chore: release martin-loop 0.2.7",
    },
  ]);

  assert.deepEqual(
    violations.map((violation) => violation.rule),
    [
      "internal phase numbering",
      "internal RC-state wording",
      "internal snapshot-for-CI wording",
      "internal repo name",
      "handoff process language",
      "public cleanup process wording",
      "release bookkeeping subject",
    ],
  );
});

test("parseCommitSubjectLog parses git log subject output", () => {
  assert.deepEqual(
    parseCommitSubjectLog("abc123\0Clarify public copy\n"),
    [
      {
        sha: "abc123",
        subject: "Clarify public copy",
      },
    ],
  );
});
