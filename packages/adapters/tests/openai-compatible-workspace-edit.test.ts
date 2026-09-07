import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createOpenAiCompatibleAdapter } from "../src/openai-compatible.js";

interface MockResponse {
  status?: number;
  body: unknown;
}

function startMockServer(handler: (req: IncomingMessage, body: string) => MockResponse): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let raw = "";
      req.on("data", (chunk: Buffer) => { raw += chunk.toString(); });
      req.on("end", () => {
        const { status = 200, body } = handler(req, raw);
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

async function createWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "martin-openai-workspace-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await mkdir(join(dir, "config"), { recursive: true });
  await writeFile(join(dir, "src", "billing.js"), "export const annual = false;\n", "utf8");
  await writeFile(join(dir, "config", "billing-policy.json"), '{"annualDiscountPct":15}\n', "utf8");
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@martinloop.local"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "MartinLoop Test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "baseline"], { cwd: dir, stdio: "ignore" });
  return dir;
}

function makeRequest(workingDirectory: string) {
  return {
    loopId: "loop_model_agnostic",
    workspaceId: "ws_model_agnostic",
    attemptId: "att_model_agnostic",
    context: {
      taskTitle: "Enable annual billing",
      objective: "Enable annual billing in src/billing.js without changing billing policy.",
      verificationPlan: [
        "node -e \"const fs=require('fs');process.exit(fs.readFileSync('src/billing.js','utf8').includes('annual = true')?0:1)\""
      ],
      repoRoot: workingDirectory,
      allowedPaths: ["src/**"],
      deniedPaths: ["config/**"],
      acceptanceCriteria: ["annual billing is enabled", "billing policy is unchanged"],
      mutationMode: "edit" as const,
      focus: "",
      remainingBudgetUsd: 3,
      remainingIterations: 2,
      remainingTokens: 10_000
    },
    previousAttempts: []
  };
}

describe("OpenAI-compatible governed workspace edits", () => {
  const cleanup: string[] = [];
  let closeServer: (() => void) | undefined;

  afterEach(async () => {
    closeServer?.();
    closeServer = undefined;
    await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  for (const model of [
    "moonshotai/kimi-k2",
    "nvidia/llama-3.1-nemotron-70b-instruct",
  ]) {
    it(`applies governed edits and verifies ${model}`, async () => {
      const workingDirectory = await createWorkspace();
      cleanup.push(workingDirectory);
      const { url, close } = await startMockServer(() => ({
        body: {
          choices: [{
            message: {
              role: "assistant",
              content: JSON.stringify({
                summary: "Enable annual billing",
                edits: [{ path: "src/billing.js", content: "export const annual = true;\n" }],
                deletions: []
              })
            },
            finish_reason: "stop"
          }],
          usage: { prompt_tokens: 300, completion_tokens: 80 }
        }
      }));
      closeServer = close;

      const adapter = createOpenAiCompatibleAdapter({
        baseUrl: url,
        model,
        workingDirectory
      });
      const result = await adapter.execute(makeRequest(workingDirectory) as any);

      expect(result.status).toBe("completed");
      expect(result.verification.passed).toBe(true);
      expect(await readFile(join(workingDirectory, "src", "billing.js"), "utf8")).toContain("annual = true");
      expect(await readFile(join(workingDirectory, "config", "billing-policy.json"), "utf8")).toContain("15");
      expect(result.execution?.changedFiles).toContain("src/billing.js");
    });
  }

  it("rejects a denied edit before touching the protected file", async () => {
    const workingDirectory = await createWorkspace();
    cleanup.push(workingDirectory);
    const before = await readFile(join(workingDirectory, "config", "billing-policy.json"), "utf8");
    const { url, close } = await startMockServer(() => ({
      body: {
        choices: [{
          message: {
            role: "assistant",
            content: JSON.stringify({
              edits: [{ path: "config/billing-policy.json", content: '{"annualDiscountPct":25}\n' }],
              deletions: []
            })
          }
        }],
        usage: { prompt_tokens: 200, completion_tokens: 50 }
      }
    }));
    closeServer = close;

    const result = await createOpenAiCompatibleAdapter({
      baseUrl: url,
      model: "moonshotai/kimi-k2",
      workingDirectory
    }).execute(makeRequest(workingDirectory) as any);

    expect(result.status).toBe("failed");
    expect(result.failure?.message).toContain("WORKSPACE_EDIT_GOVERNANCE_REJECTED");
    expect(await readFile(join(workingDirectory, "config", "billing-policy.json"), "utf8")).toBe(before);
  });

  it("rejects a symlink traversal before writing outside the workspace", async () => {
    const workingDirectory = await createWorkspace();
    const outsideDirectory = await mkdtemp(join(tmpdir(), "martin-openai-outside-"));
    cleanup.push(workingDirectory, outsideDirectory);
    const outsideFile = join(outsideDirectory, "owned.js");
    await writeFile(outsideFile, "export const owned = false;\n", "utf8");

    try {
      await symlink(
        outsideDirectory,
        join(workingDirectory, "src", "external"),
        process.platform === "win32" ? "junction" : "dir"
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES" || code === "ENOSYS") {
        return;
      }
      throw error;
    }

    const { url, close } = await startMockServer(() => ({
      body: {
        choices: [{
          message: {
            role: "assistant",
            content: JSON.stringify({
              edits: [{ path: "src/external/owned.js", content: "export const owned = true;\n" }],
              deletions: []
            })
          }
        }],
        usage: { prompt_tokens: 220, completion_tokens: 60 }
      }
    }));
    closeServer = close;

    const result = await createOpenAiCompatibleAdapter({
      baseUrl: url,
      model: "moonshotai/kimi-k2",
      workingDirectory
    }).execute(makeRequest(workingDirectory) as any);

    expect(result.status).toBe("failed");
    expect(result.failure?.message).toContain("WORKSPACE_EDIT_SYMLINK_REJECTED");
    expect(await readFile(outsideFile, "utf8")).toBe("export const owned = false;\n");
  });

  it("does not let a chat-only response pass the coding verifier on an unchanged baseline", async () => {
    const workingDirectory = await createWorkspace();
    cleanup.push(workingDirectory);
    const { url, close } = await startMockServer(() => ({
      body: {
        choices: [{ message: { role: "assistant", content: "I changed the annual billing implementation." } }],
        usage: { prompt_tokens: 200, completion_tokens: 20 }
      }
    }));
    closeServer = close;

    const result = await createOpenAiCompatibleAdapter({
      baseUrl: url,
      model: "provider/unknown-coding-model",
      workingDirectory
    }).execute(makeRequest(workingDirectory) as any);

    expect(result.status).toBe("failed");
    expect(result.failure?.message).toContain("WORKSPACE_EDIT_PROTOCOL");
    expect(await readFile(join(workingDirectory, "src", "billing.js"), "utf8")).toContain("annual = false");
  });
});
