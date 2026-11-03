import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { INTERNAL_HEALTH_COMMANDS } from "../lib/internal-health-commands.mjs";

const execFileAsync = promisify(execFile);
const ROOT = resolve(import.meta.dirname, "..", "..");

test("release health consumes the authoritative required live-swarm gate", () => {
  assert.ok(INTERNAL_HEALTH_COMMANDS.some(([command, args]) => command === "node" && args.length === 1 && args[0] === "scripts/verify-release-consumer.mjs"));
});

test("release consumer classifies absent external evidence as UNKNOWN and exits nonzero", async () => {
  try {
    await execFileAsync(process.execPath, ["scripts/verify-release-consumer.mjs"], {
      cwd: ROOT,
      env: { ...process.env, MARTIN_LIVE_SWARM_RECEIPT: "", MARTIN_LIVE_SWARM_TRUST_ROOT: "" },
    });
    assert.fail("release consumer must not pass without external evidence");
  } catch (error) {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /"decision"\s*:\s*"UNKNOWN"/u);
    assert.doesNotMatch(error.stderr, /PASS/u);
  }
});
