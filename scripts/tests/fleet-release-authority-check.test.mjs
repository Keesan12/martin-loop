import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  collectReleaseAuthorityFailures,
} from "../fleet-release-authority-check.mjs";

const TEST_RELEASE_VERSION = "0.5.6";

test("release authority accepts an aligned 0.5.6 candidate", async () => {
  await withFixture(async (rootDir) => {
    assert.deepEqual(await collectReleaseAuthorityFailures(rootDir), []);
  });
});

test("release authority rejects drift across package, server, truth, runtime, and facade surfaces", async () => {
  await withFixture(async (rootDir) => {
    await writeJson(path.join(rootDir, "packages", "mcp", "server.json"), {
      version: "0.5.5",
      packages: [{ registryType: "npm", identifier: "@martinloop/mcp", version: "0.5.5" }],
    });
    await writeJson(path.join(rootDir, "docs", "product-truth", "public-release-truth.json"), {
      cliVersion: "0.5.5",
      mcpVersion: "0.5.5",
    });
    await writeFile(
      path.join(rootDir, "packages", "mcp", "src", "package-version.ts"),
      'export const MARTIN_MCP_PACKAGE_VERSION = "0.5.5";\n',
      "utf8",
    );
    await writeJson(path.join(rootDir, "dist", "vendor", "cli", "package.json"), {
      name: "@martin/cli",
      version: "0.5.5",
    });
    await writeJson(path.join(rootDir, "packages", "mcp", "mcpb", "manifest.json"), {
      manifest_version: "0.3",
      version: "0.5.5",
    });
    await writeJson(path.join(rootDir, "plugins", "martinloop", "plugin.json"), {
      name: "martinloop",
      version: "0.5.5",
    });
    await writeJson(path.join(rootDir, "plugins", "martinloop", ".mcp.json"), {
      mcpServers: { "martin-loop": { args: ["-y", "@martinloop/mcp@0.5.5"] } },
    });

    const failures = await collectReleaseAuthorityFailures(rootDir);
    const message = failures.join("\n");
    assert.match(message, /MCP server version expected 0\.5\.6; received 0\.5\.5/);
    assert.match(message, /public release truth cliVersion expected 0\.5\.6; received 0\.5\.5/);
    assert.match(message, /MCP runtime version expected 0\.5\.6; received 0\.5\.5/);
    assert.match(message, /vendored CLI version expected 0\.5\.6; received 0\.5\.5/);
    assert.match(message, /MCPB product version expected 0\.5\.6; received 0\.5\.5/);
    assert.match(message, /plugin version expected 0\.5\.6; received 0\.5\.5/);
    assert.match(message, /plugin MCP package version expected 0\.5\.6; received 0\.5\.5/);
  });
});

test("release authority rejects source MCP config without presentation resolution", async () => {
  await withFixture(async (rootDir) => {
    await writeJson(path.join(rootDir, "packages", "mcp", "tsconfig.json"), {
      compilerOptions: { paths: { "@martin/core": ["../core/src/index.ts"] } },
    });

    const failures = await collectReleaseAuthorityFailures(rootDir);
    assert.match(failures.join("\n"), /source MCP tsconfig must resolve @martin\/presentation/);
  });
});

test("release authority rejects stale current docs but permits historical release text", async () => {
  await withFixture(async (rootDir) => {
    await writeFile(
      path.join(rootDir, "docs", "release", "VERSION-LEDGER.md"),
      [
        "- current in-repo root release line: `0.3.16`",
        "- historical release `0.3.16` remains recorded",
        "",
      ].join("\n"),
      "utf8",
    );

    const failures = await collectReleaseAuthorityFailures(rootDir);
    const message = failures.join("\n");
    assert.match(message, /stale current release reference/);
    assert.doesNotMatch(message, /historical release.*remains recorded/);
  });
});

test("release authority rejects a pending candidate mislabeled as live", async () => {
  await withFixture(async (rootDir) => {
    await writeFile(
      path.join(rootDir, "docs", "release", "VERSION-LEDGER.md"),
      [
        "- live npm dist-tag `latest`: `0.5.6`",
        "- live public GitHub release: `v0.5.6`",
        "- current in-repo root release target: `0.5.6` (pending publication)",
        "- live npm dist-tag `latest`: `0.5.6`",
        "- live public GitHub release: `mcp-v0.5.6`",
        "- current in-repo standalone release target: `0.5.6` (pending publication)",
        "",
      ].join("\n"),
      "utf8",
    );

    const failures = await collectReleaseAuthorityFailures(rootDir);
    assert.match(failures.join("\n"), /pending candidate 0\.5\.6 must not be presented as live/);
  });
});

test("release authority rejects stale current install authority in README", async () => {
  await withFixture(async (rootDir) => {
    await writeFile(
      path.join(rootDir, "README.md"),
      [
        "Release notes for the current root package: MartinLoop 0.5.5.",
        "For deterministic installs, pin `martin-loop@0.5.5`.",
        "<!-- MCP package: @martinloop/mcp@0.5.5 -->",
        "",
      ].join("\n"),
      "utf8",
    );

    const failures = await collectReleaseAuthorityFailures(rootDir);
    assert.match(failures.join("\n"), /README\.md:1 stale current release reference 0\.5\.5/);
    assert.match(failures.join("\n"), /README\.md:2 stale current release reference 0\.5\.5/);
    assert.match(failures.join("\n"), /README\.md:3 stale current release reference 0\.5\.5/);
  });
});

async function withFixture(run) {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "martin-release-authority-"));
  try {
    for (const relativeDir of [
      "packages/mcp/src",
      "packages/cli/src",
      "packages/presentation/src",
      "packages/mcp/mcpb",
      "docs/product-truth",
      "docs/release",
      "dist/vendor/cli",
      "plugins/martinloop",
    ]) {
      await mkdir(path.join(rootDir, relativeDir), { recursive: true });
    }

    await writeJson(path.join(rootDir, "package.json"), {
      name: "martin-loop",
      version: TEST_RELEASE_VERSION,
    });
    await writeJson(path.join(rootDir, "packages", "mcp", "package.json"), {
      name: "@martinloop/mcp",
      version: TEST_RELEASE_VERSION,
    });
    await writeJson(path.join(rootDir, "packages", "mcp", "server.json"), {
      version: TEST_RELEASE_VERSION,
      packages: [
        {
          registryType: "npm",
          identifier: "@martinloop/mcp",
          version: TEST_RELEASE_VERSION,
        },
      ],
    });
    await writeJson(path.join(rootDir, "docs", "product-truth", "public-release-truth.json"), {
      schemaVersion: "1.0.0",
      cliVersion: TEST_RELEASE_VERSION,
      mcpVersion: TEST_RELEASE_VERSION,
      failureClassCount: 13,
    });
    await writeJson(path.join(rootDir, "dist", "vendor", "cli", "package.json"), {
      name: "@martin/cli",
      version: TEST_RELEASE_VERSION,
    });
    await writeJson(path.join(rootDir, "packages", "mcp", "mcpb", "manifest.json"), {
      manifest_version: "0.3",
      version: TEST_RELEASE_VERSION,
    });
    await writeJson(path.join(rootDir, "plugins", "martinloop", "plugin.json"), {
      name: "martinloop",
      version: TEST_RELEASE_VERSION,
    });
    await writeJson(path.join(rootDir, "plugins", "martinloop", ".mcp.json"), {
      mcpServers: {
        "martin-loop": {
          args: ["-y", `@martinloop/mcp@${TEST_RELEASE_VERSION}`],
        },
      },
    });
    await writeJson(path.join(rootDir, "packages", "mcp", "tsconfig.json"), {
      compilerOptions: {
        paths: { "@martin/presentation": ["../presentation/src/index.ts"] },
      },
    });
    await writeJson(path.join(rootDir, "packages", "mcp", "tsconfig.build.json"), {
      compilerOptions: {
        paths: { "@martin/presentation": ["../presentation/dist/index.d.ts"] },
      },
    });
    await writeFile(
      path.join(rootDir, "packages", "mcp", "src", "package-version.ts"),
      `export const MARTIN_MCP_PACKAGE_VERSION = "${TEST_RELEASE_VERSION}";\n`,
      "utf8",
    );
    await writeFile(
      path.join(rootDir, "docs", "release", "VERSION-LEDGER.md"),
      [
        "- live npm dist-tag `latest`: `0.5.5`",
        "- live public GitHub release: `v0.5.5`",
        `- current in-repo root release target: \`${TEST_RELEASE_VERSION}\` (pending publication)`,
        "- live npm dist-tag `latest`: `0.5.5`",
        "- live public GitHub release: `mcp-v0.5.5`",
        `- current in-repo standalone release target: \`${TEST_RELEASE_VERSION}\` (pending publication)`,
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      path.join(rootDir, "README.md"),
      [
        `Release notes for the current root package: MartinLoop ${TEST_RELEASE_VERSION}.`,
        `For deterministic installs, pin \`martin-loop@${TEST_RELEASE_VERSION}\`.`,
        `<!-- MCP package: @martinloop/mcp@${TEST_RELEASE_VERSION} -->`,
        "",
      ].join("\n"),
      "utf8",
    );

    await run(rootDir);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
