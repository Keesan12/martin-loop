/**
 * Tests for the block-public-oss-writes.js guardrail hook.
 *
 * Covers:
 *   - False-positive fix: commit messages / heredoc bodies containing blocked
 *     phrases must not trigger the hook on legitimate internal operations.
 *   - True positives: actual public mutations remain blocked.
 *   - CI workflow scope: public-promotion-guard.yml must only run on
 *     public-staging/* branches (not on ordinary internal feature PRs).
 */

import { test } from "node:test";
import assert from "node:assert";
import { spawnSync } from "node:child_process";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const HOOK_PATH = resolve(import.meta.dirname, "..", "hooks", "block-public-oss-writes.js");
const INSTALLER_PATH = resolve(import.meta.dirname, "..", "hooks", "install-claude-public-write-hook.js");

/**
 * Invoke the hook with a synthesised tool_input object.
 * Returns the process exit code: 0 = allowed, 2 = blocked.
 */
function invoke(toolInput) {
  const result = spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify({ tool_input: toolInput }),
    encoding: "utf8",
    timeout: 8_000,
  });
  return result.status;
}

function makeRemoteRepo(remoteName, url) {
  const dir = mkdtempSync(join(tmpdir(), "martin-public-hook-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["remote", "add", remoteName, url], { cwd: dir, stdio: "ignore" });
  return dir;
}

function makeRemoteRepoWithPushUrl(remoteName, fetchUrl, pushUrl) {
  const dir = makeRemoteRepo(remoteName, fetchUrl);
  execFileSync("git", ["remote", "set-url", "--push", remoteName, pushUrl], { cwd: dir, stdio: "ignore" });
  return dir;
}

const ALLOW = 0;
const BLOCK = 2;

// ── CI workflow scope ──────────────────────────────────────────────────────

test("public-promotion-guard.yml gates on public-staging/* branches only", () => {
  const wfPath = new URL(
    "../../.github/workflows/public-promotion-guard.yml",
    import.meta.url
  );
  const wf = readFileSync(wfPath, "utf8");
  assert.match(
    wf,
    /startsWith\s*\(\s*github\.head_ref\s*,\s*['"]public-staging\//,
    "job must have: if: startsWith(github.head_ref, 'public-staging/') — " +
      "to avoid requiring a promotion manifest on ordinary internal PRs"
  );
});

// ── ALLOW: legitimate internal operations ──────────────────────────────────

test("internal git add is allowed", () => {
  assert.strictEqual(
    invoke({ command: "git add packages/core/src/index.ts" }),
    ALLOW
  );
});

test("internal git commit is allowed", () => {
  assert.strictEqual(
    invoke({ command: "git commit -m \"fix: update internal guardrail tests\"" }),
    ALLOW
  );
});

test("internal git push to non-public origin branch is allowed", () => {
  assert.strictEqual(
    invoke({ command: "git push origin feat/my-internal-feature" }),
    ALLOW
  );
});

test("internal git push to private origin URL is allowed", () => {
  const dir = makeRemoteRepo("origin", "https://github.com/martin-Loop/ML_Core_OSS_Internal.git");
  try {
    assert.strictEqual(invoke({ command: `cd "${dir}" && git push origin feat/my-internal-feature` }), ALLOW);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("internal git fetch is allowed", () => {
  assert.strictEqual(invoke({ command: "git fetch origin" }), ALLOW);
});

test("read-only gh pr view on any repo is allowed", () => {
  // gh pr view is not a mutating command — read-only operations are exempt.
  assert.strictEqual(
    invoke({ command: "gh pr view 42 --repo Keesan12/martin-loop" }),
    ALLOW
  );
});

test("internal gh pr create is allowed", () => {
  assert.strictEqual(
    invoke({ command: "gh pr create --repo martin-Loop/ML_Core_OSS_Internal --title guardrail" }),
    ALLOW
  );
});

test("internal gh pr merge is allowed", () => {
  assert.strictEqual(
    invoke({ command: "gh pr merge 66 --repo martin-Loop/ML_Core_OSS_Internal --squash" }),
    ALLOW
  );
});

test("read-only public fetch is allowed", () => {
  assert.strictEqual(
    invoke({ command: "git fetch https://github.com/Keesan12/martin-loop.git main" }),
    ALLOW
  );
});

test("installer is idempotent in a fake hook home", () => {
  const hookHome = mkdtempSync(join(tmpdir(), "martin-hook-home-"));
  const env = { ...process.env, MARTIN_CLAUDE_HOOK_HOME: hookHome };
  try {
    const first = spawnSync(process.execPath, [INSTALLER_PATH], { encoding: "utf8", env });
    const second = spawnSync(process.execPath, [INSTALLER_PATH], { encoding: "utf8", env });
    const installed = join(hookHome, ".claude", "scripts", "hooks", "block-public-oss-writes.js");
    assert.strictEqual(first.status, 0);
    assert.strictEqual(second.status, 0);
    assert.strictEqual(existsSync(installed), true);
    assert.strictEqual(readFileSync(installed, "utf8"), readFileSync(HOOK_PATH, "utf8"));
  } finally {
    rmSync(hookHome, { recursive: true, force: true });
  }
});

// False-positive regression tests — the key fix in this PR.

test("commit -m flag containing 'npm publish' text does not false-positive", () => {
  // This was the root false positive: a git add+commit chain whose -m body
  // contained "npm publish" as a description, not as an actual command.
  assert.strictEqual(
    invoke({ command: `git commit -m "fix: block npm publish until promotion is complete"` }),
    ALLOW,
    "commit message body containing 'npm publish' must not be blocked"
  );
});

test("git add && git commit chain with npm publish in message does not false-positive", () => {
  // Simulates the actual sequence that was blocked in session 2026-08-02:
  // git add ... && git commit -m "$(cat <<'EOF'\nchore: add npm publish guard\nEOF\n)"
  // After whitespace normalization the heredoc body becomes part of the command string.
  const command =
    `git add AGENTS.md CLAUDE.md && ` +
    `git commit -m "$(cat <<'EOF' chore: add npm publish guard and promotion rules EOF )"`;
  assert.strictEqual(invoke({ command }), ALLOW);
});

test("internal heredoc commit body containing blocked phrases does not false-positive", () => {
  const command =
    `git commit -F "$(cat <<'EOF' ` +
    `Document npm publish, git tag v1.2.3, and Keesan12/martin-loop promotion rules ` +
    `EOF )"`;
  assert.strictEqual(invoke({ command }), ALLOW);
});

test("commit message containing 'git tag v1.2.3' text does not false-positive", () => {
  assert.strictEqual(
    invoke({ command: `git commit -m "docs: document git tag v1.2.3 release process"` }),
    ALLOW,
    "commit message containing a version tag reference must not be blocked"
  );
});

test("single-quoted commit -m with npm publish text does not false-positive", () => {
  assert.strictEqual(
    invoke({ command: `git commit -m 'chore: prevent npm publish without manifest'` }),
    ALLOW
  );
});

test("commit message containing public PR command text does not false-positive", () => {
  assert.strictEqual(
    invoke({ command: `git commit -m "docs: explain gh pr merge --repo Keesan12/martin-loop"` }),
    ALLOW
  );
});

// ── BLOCK: actual public mutations ─────────────────────────────────────────

test("bare npm publish is blocked", () => {
  assert.strictEqual(invoke({ command: "npm publish" }), BLOCK);
});

test("npm publish with flags is blocked", () => {
  assert.strictEqual(invoke({ command: "npm publish --access public" }), BLOCK);
});

test("git push to public repo slug is blocked", () => {
  assert.strictEqual(
    invoke({ command: "git push Keesan12/martin-loop main" }),
    BLOCK
  );
});

test("git push to public HTTPS URL is blocked", () => {
  assert.strictEqual(
    invoke({ command: "git push https://github.com/Keesan12/martin-loop.git main" }),
    BLOCK
  );
});

test("git push to public SSH URL is blocked", () => {
  assert.strictEqual(
    invoke({ command: "git push git@github.com:Keesan12/martin-loop.git main" }),
    BLOCK
  );
});

test("git push via remote named public is blocked", () => {
  const dir = makeRemoteRepo("public", "https://github.com/Keesan12/martin-loop.git");
  try {
    assert.strictEqual(invoke({ command: `cd "${dir}" && git push public main` }), BLOCK);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git push via remote named origin is blocked when origin resolves to public repo", () => {
  const dir = makeRemoteRepo("origin", "https://github.com/Keesan12/martin-loop.git");
  try {
    assert.strictEqual(invoke({ command: `cd "${dir}" && git push origin main` }), BLOCK);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git push via arbitrary alias is blocked when alias resolves to public repo", () => {
  const dir = makeRemoteRepo("upstream-prod", "git@github.com:Keesan12/martin-loop.git");
  try {
    assert.strictEqual(invoke({ command: `cd "${dir}" && git push upstream-prod main` }), BLOCK);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git push is blocked when push URL differs from private fetch URL", () => {
  const dir = makeRemoteRepoWithPushUrl(
    "origin",
    "https://github.com/martin-Loop/ML_Core_OSS_Internal.git",
    "https://github.com/Keesan12/martin-loop.git"
  );
  try {
    assert.strictEqual(invoke({ command: `cd "${dir}" && git push origin main` }), BLOCK);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git add from public repo cwd is blocked", () => {
  assert.strictEqual(
    invoke({ command: `cd "C:/tmp/martin-loop_PUBLIC_OSS" && git add README.md` }),
    BLOCK
  );
});

test("gh pr create targeting public repo is blocked", () => {
  assert.strictEqual(
    invoke({ command: "gh pr create --repo Keesan12/martin-loop --title test" }),
    BLOCK
  );
});

test("gh pr merge targeting public repo is blocked", () => {
  assert.strictEqual(
    invoke({ command: "gh pr merge 99 --repo Keesan12/martin-loop --squash" }),
    BLOCK
  );
});

test("gh release create targeting public repo is blocked", () => {
  assert.strictEqual(
    invoke({ command: "gh release create v1.0.0 --repo Keesan12/martin-loop" }),
    BLOCK
  );
});

test("gh release delete targeting public repo is blocked", () => {
  assert.strictEqual(
    invoke({ command: "gh release delete v1.0.0 --repo Keesan12/martin-loop" }),
    BLOCK
  );
});

test("git tag with semver is blocked", () => {
  assert.strictEqual(invoke({ command: "git tag v1.2.3" }), BLOCK);
});

test("simple chained-command npm publish bypass is blocked", () => {
  assert.strictEqual(invoke({ command: "echo safe && npm publish" }), BLOCK);
});

test("bash -c wrapper around npm publish is blocked", () => {
  assert.strictEqual(invoke({ command: "bash -c \"npm publish\"" }), BLOCK);
});

test("cmd /c wrapper around public push is blocked", () => {
  assert.strictEqual(
    invoke({ command: "cmd /c git push https://github.com/Keesan12/martin-loop.git main" }),
    BLOCK
  );
});

test("powershell -Command wrapper around public release is blocked", () => {
  assert.strictEqual(
    invoke({ command: "powershell -Command \"gh release create v1.0.0 --repo Keesan12/martin-loop\"" }),
    BLOCK
  );
});

test("file edit targeting martin-loop_PUBLIC_OSS path is blocked", () => {
  assert.strictEqual(
    invoke({ file_path: "/path/to/martin-loop_PUBLIC_OSS/README.md" }),
    BLOCK
  );
});
