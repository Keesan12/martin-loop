import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { executeCli } from "../src/index.js";
import { renderDeterministicSwarmDemoHuman, runDeterministicSwarmDemo } from "../src/swarm-demo.js";

// `demo --swarm` is intentionally a non-persisted local simulation. Its output and the
// `swarm status` not-found error must say how to inspect it instead.

const temporaryDirectories: string[] = [];

async function createTemp(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("swarm demo inspection guidance", () => {
  it("tells the operator where demo evidence lives and that live swarm commands will not find it", async () => {
    const result = await runDeterministicSwarmDemo({ targetDirectory: await createTemp("martin-swarm-guidance-") });
    const human = renderDeterministicSwarmDemoHuman(result);

    expect(human).toMatch(/demo --swarm --json/u);
    expect(human).toMatch(/swarm status.*inspect.*verify.*share.*live/u);
    for (const forbiddenClaim of ["SWARM VERIFIED", "DEMO VERIFIED", "GOVERNED BY MARTINLOOP"]) {
      expect(human).not.toContain(forbiddenClaim);
    }
  });

  it("explains on swarm status --latest that demo output is never persisted", async () => {
    const runsDir = await createTemp("martin-swarm-guidance-runs-");
    const result = await executeCli(["swarm", "status", "--latest", "--runs-dir", runsDir, "--json"]);

    expect(result.exitCode).not.toBe(0);
    const payload = JSON.parse(result.stdout) as { category: string; suggestion?: string };
    expect(payload.category).toBe("not_found");
    expect(payload.suggestion).toMatch(/demo --swarm.*not persisted/u);
  });
});
