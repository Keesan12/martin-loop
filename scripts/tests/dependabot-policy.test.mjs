import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolve } from "node:path";

const PUBLIC_REPOSITORY = "Keesan12/martin-loop";
const dependabotPath = resolve(".github/dependabot.yml");

function normalizeRepositoryIdentity(value) {
  return String(value ?? "")
    .trim()
    .replaceAll("\\", "/")
    .toLowerCase()
    .replace(/^https?:\/\/github\.com\//u, "")
    .replace(/^ssh:\/\/git@github\.com\//u, "")
    .replace(/^git@github\.com:/u, "")
    .replace(/^\/+|\/+$/gu, "")
    .replace(/\.git$/u, "");
}

export function repositoryIdentity({
  env = process.env,
  readOrigin = () => execFileSync("git", ["config", "--get", "remote.origin.url"], {
    encoding: "utf8",
  }),
} = {}) {
  if (env.GITHUB_REPOSITORY) return normalizeRepositoryIdentity(env.GITHUB_REPOSITORY);
  try {
    return normalizeRepositoryIdentity(readOrigin());
  } catch {
    return "";
  }
}

function ecosystemBlock(config, ecosystem) {
  const normalized = config.replace(/\r\n/g, "\n");
  const escaped = ecosystem.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = normalized.match(
    new RegExp(`(?:^|\\n)  - package-ecosystem: ${escaped}\\n([\\s\\S]*?)(?=\\n  - package-ecosystem:|$)`),
  );
  assert.ok(match, `missing ${ecosystem} Dependabot configuration`);
  return match[1];
}

test("dependency automation is grouped at its source and disabled in public distribution", () => {
  const repository = repositoryIdentity();

  if (repository === PUBLIC_REPOSITORY.toLowerCase()) {
    assert.throws(
      () => readFileSync(dependabotPath, "utf8"),
      { code: "ENOENT" },
      "the public distribution repository must not originate dependency-update PRs",
    );
    return;
  }

  const config = readFileSync(dependabotPath, "utf8");

  for (const ecosystem of ["github-actions", "npm"]) {
    const block = ecosystemBlock(config, ecosystem);
    assert.match(block, /open-pull-requests-limit: 1/);
    assert.match(block, /groups:\n      [a-z0-9-]+:\n        patterns:\n          - "\*"/);
  }
});

test("repository identity is unknown rather than fatal when origin is absent", () => {
  assert.equal(repositoryIdentity({
    env: {},
    readOrigin: () => {
      const error = new Error("missing remote.origin.url");
      error.status = 1;
      throw error;
    },
  }), "");
});

test("repository identity matches only the exact public owner and repository", () => {
  assert.equal(repositoryIdentity({ env: { GITHUB_REPOSITORY: "Keesan12/MARTIN-LOOP" } }), "keesan12/martin-loop");
  assert.equal(repositoryIdentity({ env: { GITHUB_REPOSITORY: "Keesan12/martin-loop-fork" } }), "keesan12/martin-loop-fork");
  assert.equal(repositoryIdentity({ env: {}, readOrigin: () => "git@github.com:Keesan12/martin-loop.git\n" }), "keesan12/martin-loop");
});
