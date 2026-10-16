import { describe, expect, it } from "vitest";

import { evaluateChangeApprovalLeash, evaluateFilesystemLeash } from "../src/index";

describe("evaluateFilesystemLeash protected secret files", () => {
  it.each([".env", "config/.env.production", "certs/server.pem", "deploy/tls.key", "keys/id_rsa", "store.p12"])(
    "blocks an agent write to %s",
    (file) => {
      const decision = evaluateFilesystemLeash({ repoRoot: "/repo", changedFiles: [file] });

      expect(decision.allowed).toBe(false);
      expect(decision.violations).toEqual([expect.objectContaining({ file, kind: "protected_path" })]);
    }
  );

  it.each([".env.example", ".env.sample", ".env.template", "src/keys.ts", "docs/env.md", "keys/id_rsa.pub", "src/monkey.ts"])(
    "allows ordinary file %s",
    (file) => {
      expect(evaluateFilesystemLeash({ repoRoot: "/repo", changedFiles: [file] }).allowed).toBe(true);
    }
  );

  it("allows a protected file the operator names explicitly in allowed paths", () => {
    const decision = evaluateFilesystemLeash({
      repoRoot: "/repo",
      changedFiles: [".env", "src/app.ts"],
      allowedPaths: [".env", "src/**"]
    });

    expect(decision.allowed).toBe(true);
  });

  it("does not treat a broad wildcard allow as approval for protected files", () => {
    const decision = evaluateFilesystemLeash({
      repoRoot: "/repo",
      changedFiles: [".env"],
      allowedPaths: ["**"]
    });

    expect(decision.violations).toEqual([expect.objectContaining({ file: ".env", kind: "protected_path" })]);
  });

  it("checks ignored files only against denied paths and protected files", () => {
    const decision = evaluateFilesystemLeash({
      repoRoot: "/repo",
      changedFiles: ["src/app.ts"],
      ignoredFiles: ["secrets/token.txt", "dist/bundle.js", ".env.local", "node_modules/", "node_modules/pkg/server.key"],
      allowedPaths: ["src/**"],
      deniedPaths: ["secrets/**"]
    });

    expect(decision.violations).toEqual([
      expect.objectContaining({ file: "secrets/token.txt", kind: "path_denied" }),
      expect.objectContaining({ file: ".env.local", kind: "protected_path" })
    ]);
  });

  it("allows ignored build and dependency output", () => {
    const decision = evaluateFilesystemLeash({
      repoRoot: "/repo",
      changedFiles: ["src/app.ts"],
      ignoredFiles: ["node_modules/", "coverage/lcov.info", "dist/index.js"],
      allowedPaths: ["src/**"]
    });

    expect(decision.allowed).toBe(true);
  });
});

describe("evaluateChangeApprovalLeash test weakening", () => {
  it("requires approval when existing tests were weakened or deleted", () => {
    const decision = evaluateChangeApprovalLeash({
      changedFiles: ["src/math.js", "math.test.js"],
      weakenedTestFiles: ["math.test.js"]
    });

    expect(decision.allowed).toBe(false);
    expect(decision.violations).toEqual([
      expect.objectContaining({ file: "math.test.js", kind: "test_change_approval_required" })
    ]);
  });

  it("allows weakened tests when test-change approval is granted", () => {
    const decision = evaluateChangeApprovalLeash({
      changedFiles: ["math.test.js"],
      weakenedTestFiles: ["math.test.js"],
      approvalPolicy: { testChanges: true }
    });

    expect(decision.allowed).toBe(true);
  });

  it("allows test additions that weaken nothing", () => {
    const decision = evaluateChangeApprovalLeash({
      changedFiles: ["math.test.js", "src/math.js"],
      weakenedTestFiles: []
    });

    expect(decision.allowed).toBe(true);
  });
});
