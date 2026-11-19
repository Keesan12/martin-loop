import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { martinDoctorTool } from "../src/tools/doctor.js";
import { martinPreflightTool } from "../src/tools/preflight.js";
import { runLoopTool } from "../src/tools/run-loop.js";
import { getEngineAvailability } from "../src/tools/tool-support.js";

const MANAGED_ENV = [
  "APPDATA",
  "HOME",
  "MARTIN_LIVE",
  "MARTIN_OPENAI_API_KEY",
  "MARTIN_OPENAI_BASE_URL",
  "MARTIN_OPENAI_BILLING_MODE",
  "MARTIN_OPENAI_MODEL",
  "MARTIN_RUNS_DIR",
  "PATH",
  "Path",
  "PATHEXT",
  "USERPROFILE",
] as const;

const originalEnv = new Map(MANAGED_ENV.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("MCP provider portability", () => {
  it("accepts a configured local OpenAI-compatible endpoint without an openai executable", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-mcp-doctor-runs-"));
    process.env.MARTIN_LIVE = "true";
    process.env.MARTIN_OPENAI_BASE_URL = "http://127.0.0.1:11434";
    process.env.MARTIN_OPENAI_MODEL = "local-test-model";
    process.env.MARTIN_RUNS_DIR = runsRoot;
    delete process.env.MARTIN_OPENAI_API_KEY;

    try {
      const result = await martinPreflightTool({
        objective: "Inspect the configured local model",
        engine: "openai",
        verificationPlan: ["node --version"],
      });

      expect(result.ok).toBe(true);
      expect(result.execution.engineAvailability).toMatchObject({
        available: true,
        transport: "http",
      });
      expect(result.execution.engineAvailability.detail).toContain("local-test-model");

      const doctor = await martinDoctorTool({ engine: "openai" });
      expect(doctor.engines.openai).toMatchObject({
        available: true,
        transport: "http",
      });
      expect(doctor.warnings).not.toEqual(expect.arrayContaining([
        expect.stringContaining("Requested engine 'openai' is not ready"),
      ]));
    } finally {
      await rm(runsRoot, { recursive: true, force: true });
    }
  });

  it("uses the request model override for OpenAI-compatible readiness", async () => {
    process.env.MARTIN_LIVE = "true";
    process.env.MARTIN_OPENAI_BASE_URL = "http://127.0.0.1:11434";
    delete process.env.MARTIN_OPENAI_MODEL;
    delete process.env.MARTIN_OPENAI_API_KEY;

    const result = await martinPreflightTool({
      objective: "Inspect the explicitly selected local model",
      engine: "openai",
      model: "request-local-model",
      verificationPlan: ["node --version"],
    });

    expect(result.ok).toBe(true);
    expect(result.execution.engineAvailability.detail).toContain("request-local-model");
  });

  it("requires explicit pricing authority for unknown remote models", async () => {
    process.env.MARTIN_LIVE = "true";
    process.env.MARTIN_OPENAI_BASE_URL = "https://proxy.example.com/v1";
    process.env.MARTIN_OPENAI_MODEL = "vendor/custom-model";
    process.env.MARTIN_OPENAI_API_KEY = "configured-secret";

    const blocked = await martinPreflightTool({
      objective: "Reject an unpriced remote model",
      engine: "openai",
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.execution.engineAvailability.detail).toContain("PRICING_CONFIGURATION_REQUIRED");
    await expect(runLoopTool({
      objective: "Reject an unpriced remote model",
      engine: "openai",
      maxIterations: 1,
    })).rejects.toMatchObject({
      name: "MartinToolError",
      code: "engine_unavailable",
      category: "environment",
    });

    const admitted = await martinPreflightTool({
      objective: "Admit an explicitly priced remote model",
      engine: "openai",
      pricePerMTokenUsd: 12.5,
    });
    expect(admitted.ok).toBe(true);
    expect(getEngineAvailability("openai", undefined, Number.NaN).detail)
      .toContain("INVALID_OPENAI_PRICE");
  });

  it("returns structured diagnostics for an invalid OpenAI-compatible billing mode", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-mcp-invalid-openai-"));
    process.env.MARTIN_LIVE = "true";
    process.env.MARTIN_OPENAI_BASE_URL = "http://127.0.0.1:11434";
    process.env.MARTIN_OPENAI_MODEL = "local-test-model";
    process.env.MARTIN_OPENAI_BILLING_MODE = "free-ish";
    process.env.MARTIN_RUNS_DIR = runsRoot;

    try {
      const preflight = await martinPreflightTool({
        objective: "Reject malformed billing configuration",
        engine: "openai",
      });
      expect(preflight.ok).toBe(false);
      expect(preflight.execution.engineAvailability).toMatchObject({
        available: false,
        transport: "http",
      });
      expect(preflight.execution.engineAvailability.detail).toContain("INVALID_OPENAI_BILLING_MODE");

      const doctor = await martinDoctorTool({ engine: "openai" });
      expect(doctor.status).toBe("degraded");
      expect(doctor.engines.openai.available).toBe(false);
      expect(doctor.engines.openai.detail).toContain("INVALID_OPENAI_BILLING_MODE");

      await expect(runLoopTool({
        objective: "Reject malformed billing configuration",
        engine: "openai",
        maxIterations: 1,
      })).rejects.toMatchObject({
        name: "MartinToolError",
        code: "engine_unavailable",
        category: "environment",
      });
    } finally {
      await rm(runsRoot, { recursive: true, force: true });
    }
  });

  it("rejects a malformed OpenAI-compatible endpoint during readiness", async () => {
    process.env.MARTIN_LIVE = "true";
    process.env.MARTIN_OPENAI_BASE_URL = "not a valid endpoint";
    process.env.MARTIN_OPENAI_MODEL = "configured-model";
    process.env.MARTIN_OPENAI_API_KEY = "configured-secret";

    const result = await martinPreflightTool({
      objective: "Reject malformed endpoint configuration",
      engine: "openai",
    });

    expect(result.ok).toBe(false);
    expect(result.execution.engineAvailability.detail).toContain("INVALID_OPENAI_BASE_URL");
    expect(result.execution.engineAvailability.detail).not.toContain("configured-secret");
  });

  it("rejects credential and query-bearing endpoints without disclosing secrets", async () => {
    process.env.MARTIN_LIVE = "true";
    process.env.MARTIN_OPENAI_BASE_URL = "https://alice:basic-secret@proxy.example.com/v1?api_key=query-secret#fragment";
    process.env.MARTIN_OPENAI_MODEL = "configured-model";
    process.env.MARTIN_OPENAI_API_KEY = "header-secret";

    const result = await martinPreflightTool({
      objective: "Inspect sanitized endpoint diagnostics",
      engine: "openai",
    });

    expect(result.ok).toBe(false);
    expect(result.execution.engineAvailability.detail).toContain("INVALID_OPENAI_BASE_URL");
    expect(result.execution.engineAvailability.detail).not.toContain("alice");
    expect(result.execution.engineAvailability.detail).not.toContain("basic-secret");
    expect(result.execution.engineAvailability.detail).not.toContain("query-secret");
    expect(result.execution.engineAvailability.detail).not.toContain("header-secret");
  });

  it("keeps an omitted engine neutral in proof mode", async () => {
    const runsRoot = await mkdtemp(join(tmpdir(), "martin-mcp-neutral-runs-"));
    process.env.MARTIN_LIVE = "false";
    process.env.MARTIN_RUNS_DIR = runsRoot;

    try {
      const preflight = await martinPreflightTool({
        objective: "Verify without selecting a provider",
        verificationPlan: ["node --version"],
      });
      expect(preflight.normalized.engine).toBe("auto");

      const run = await runLoopTool({
        objective: "Verify without selecting a provider",
        verificationPlan: [],
        maxIterations: 1,
      });
      expect(run.engine).toBe("auto");
    } finally {
      await rm(runsRoot, { recursive: true, force: true });
    }
  });

  it("does not advertise an off-PATH CLI as launchable when its exact path cannot be bound", async () => {
    const root = await mkdtemp(join(tmpdir(), "martin-mcp-off-path-"));
    const command = "martin-portability-provider";
    try {
      const bin = process.platform === "win32"
        ? join(root, "npm")
        : join(root, ".local", "bin");
      await mkdir(bin, { recursive: true });
      const executable = process.platform === "win32"
        ? join(bin, `${command}.cmd`)
        : join(bin, command);
      await writeFile(
        executable,
        process.platform === "win32" ? "@exit /b 0\r\n" : "#!/bin/sh\nexit 0\n",
        "utf8",
      );
      if (process.platform !== "win32") await chmod(executable, 0o755);

      process.env.PATH = "";
      delete process.env.Path;
      process.env.HOME = root;
      process.env.USERPROFILE = root;
      process.env.APPDATA = root;
      process.env.PATHEXT = ".COM;.EXE;.BAT;.CMD";

      const result = getEngineAvailability(command as never);

      expect(result.available).toBe(false);
      expect(result.resolvedPath).toBe(executable);
      expect(result.detail).toMatch(/exact executable path|cannot bind/iu);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
