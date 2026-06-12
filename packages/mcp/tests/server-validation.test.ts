import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { PassThrough } from "node:stream";
import { symlink, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { SpawnLike } from "@martin/adapters";
import { afterEach, describe, expect, it } from "vitest";

import {
  MARTIN_PROMPT_NAMES,
  MARTIN_RESOURCE_TEMPLATE_URIS,
  MARTIN_RESOURCE_URIS,
  MARTIN_STARTER_TOOL_NAMES,
  MARTIN_TOOL_NAMES
} from "../src/discovery-metadata.js";
import {
  sanitizeToolErrorMessage,
  resolveTrustedLoopRepoRoot,
  validateToolInput
} from "../src/server-validation.js";
import {
  __setProofModeVerifierSpawnImplForTests,
  __setRunStoreOverrideForTests
} from "../src/tools/run-loop.js";
import { createMartinMcpServer } from "../src/server.js";

type ServerRequestHandler = (request: unknown, extra: unknown) => Promise<unknown>;
type ServerWithRequestHandlers = {
  _requestHandlers: Map<string, ServerRequestHandler>;
};

function createImmediateSpawn(calls: Array<{ command: string; args: readonly string[]; options?: SpawnOptions }>): SpawnLike {
  return (command, args = [], options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter() as Partial<ChildProcess> & {
      stdout: PassThrough;
      stderr: PassThrough;
      stdin: PassThrough;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => true;
    process.nextTick(() => child.emit("close", 0));
    return child as ChildProcess;
  };
}

afterEach(() => {
  __setProofModeVerifierSpawnImplForTests(undefined);
  __setRunStoreOverrideForTests(undefined);
});

function createMemoryRunStore(runsRoot: string) {
  return {
    runsRoot,
    async initRun() {},
    async updateState() {},
    async appendLedger() {},
    async writeAttemptArtifacts() {},
    async writeLoopRecord() {}
  };
}

async function withMemoryRunStore<T>(fn: (runsRoot: string) => Promise<T>): Promise<T> {
  const runsRoot = await mkdtemp(join(tmpdir(), "martin-mcp-memory-runs-"));

  try {
    return await fn(runsRoot);
  } finally {
    await rm(runsRoot, { recursive: true, force: true }).catch(() => {});
  }
}

function readToolText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> })?.content;
  if (!Array.isArray(content) || content.length === 0 || content[0]?.type !== "text") {
    throw new Error("Expected text content from MCP tool result.");
  }
  return content[0].text ?? "";
}

async function withValidationRunsRoot<T>(fn: (runsRoot: string) => Promise<T>): Promise<T> {
  const previousRunsRoot = process.env.MARTIN_RUNS_DIR;
  const runsRoot = await mkdtemp(join(tmpdir(), "martin-mcp-validation-runs-"));
  process.env.MARTIN_RUNS_DIR = runsRoot;

  try {
    return await fn(runsRoot);
  } finally {
    if (previousRunsRoot === undefined) {
      delete process.env.MARTIN_RUNS_DIR;
    } else {
      process.env.MARTIN_RUNS_DIR = previousRunsRoot;
    }

    await rm(runsRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function withValidationWorkspaceRoot<T>(fn: (workspaceRoot: string) => Promise<T>): Promise<T> {
  const previousWorkspaceRoot = process.env.MARTIN_MCP_WORKSPACE_ROOT;
  const workspaceRoot = await mkdtemp(join(tmpdir(), "martin-mcp-validation-workspace-"));
  process.env.MARTIN_MCP_WORKSPACE_ROOT = workspaceRoot;

  try {
    return await fn(workspaceRoot);
  } finally {
    if (previousWorkspaceRoot === undefined) {
      delete process.env.MARTIN_MCP_WORKSPACE_ROOT;
    } else {
      process.env.MARTIN_MCP_WORKSPACE_ROOT = previousWorkspaceRoot;
    }

    await rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
  }
}

describe("server validation", () => {
  it("rejects hidden martin_run fields that are not part of the public schema", () => {
    expect(() =>
      validateToolInput("martin_run", {
        objective: "Fix the bug",
        parentRunId: "../escape"
      })
    ).toThrow("Unknown arguments");
  });

  it("rejects absolute and parent-traversing path patterns", () => {
    expect(() =>
      validateToolInput("martin_run", {
        objective: "Fix the bug",
        allowedPaths: ["../outside/**"]
      })
    ).toThrow("Invalid allowedPaths.");

    expect(() =>
      validateToolInput("martin_run", {
        objective: "Fix the bug",
        deniedPaths: ["C:/secret/**"]
      })
    ).toThrow("Invalid deniedPaths.");
  });

  it("rejects inspect paths that escape the Martin run store", () => {
    return withValidationRunsRoot(async () => {
      expect(() =>
        validateToolInput("martin_inspect", {
          file: "..\\..\\outside.jsonl"
        })
      ).toThrow("Invalid file.");
    });
  });

  it("allows inspect paths under the configured Martin run store", async () => {
    await withValidationRunsRoot(async (runsRoot) => {
      await mkdir(join(runsRoot, "loop_001"), { recursive: true });
      await writeFile(join(runsRoot, "loop_001", "loop-record.json"), "{}", "utf8");

      const result = validateToolInput("martin_inspect", {
        file: "loop_001/loop-record.json"
      });

      expect(result).toEqual({
        file: join(runsRoot, "loop_001", "loop-record.json")
      });
    });
  });

  it("rejects run-store paths that resolve through a junction or symlink outside the configured root", async () => {
    await withValidationRunsRoot(async (runsRoot) => {
      const outsideRoot = await mkdtemp(join(tmpdir(), "martin-mcp-validation-outside-"));
      const outsideLoopRoot = join(outsideRoot, "loop_escape");
      const linkedRoot = join(runsRoot, "runs_link");
      await mkdir(outsideLoopRoot, { recursive: true });
      await writeFile(join(outsideLoopRoot, "loop-record.json"), "{}", "utf8");
      await symlink(outsideRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");

      try {
        expect(() =>
          validateToolInput("martin_inspect", {
            file: "runs_link/loop_escape/loop-record.json"
          })
        ).toThrow("Invalid file.");
      } finally {
        await rm(outsideRoot, { recursive: true, force: true }).catch(() => {});
      }
    });
  });

  it("allows inspect paths when the configured runs root lives under a symlinked parent alias", async () => {
    const previousRunsRoot = process.env.MARTIN_RUNS_DIR;
    const realParent = await mkdtemp(join(tmpdir(), "martin-mcp-validation-real-parent-"));
    const aliasContainer = await mkdtemp(join(tmpdir(), "martin-mcp-validation-alias-parent-"));
    const realRunsRoot = join(realParent, "runs");
    const aliasParent = join(aliasContainer, "alias");
    const aliasedRunsRoot = join(aliasParent, "runs");

    await mkdir(join(realRunsRoot, "loop_001"), { recursive: true });
    await writeFile(join(realRunsRoot, "loop_001", "loop-record.json"), "{}", "utf8");
    await symlink(realParent, aliasParent, process.platform === "win32" ? "junction" : "dir");
    process.env.MARTIN_RUNS_DIR = aliasedRunsRoot;

    try {
      const result = validateToolInput("martin_inspect", {
        file: "loop_001/loop-record.json"
      });

      expect(result).toEqual({
        file: join(aliasedRunsRoot, "loop_001", "loop-record.json")
      });
    } finally {
      if (previousRunsRoot === undefined) {
        delete process.env.MARTIN_RUNS_DIR;
      } else {
        process.env.MARTIN_RUNS_DIR = previousRunsRoot;
      }

      await rm(aliasContainer, { recursive: true, force: true }).catch(() => {});
      await rm(realParent, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("rejects working directories that traverse through a symlinked workspace segment", async () => {
    await withValidationWorkspaceRoot(async (workspaceRoot) => {
      const outsideRoot = await mkdtemp(join(tmpdir(), "martin-mcp-validation-outside-workspace-"));
      const linkedRoot = join(workspaceRoot, "workspace_link");
      await mkdir(join(outsideRoot, "repo"), { recursive: true });
      await symlink(outsideRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir");

      try {
        expect(() =>
          validateToolInput("martin_run", {
            objective: "Fix the bug",
            workingDirectory: "workspace_link/repo"
          })
        ).toThrow("Invalid workingDirectory.");
      } finally {
        await rm(outsideRoot, { recursive: true, force: true }).catch(() => {});
      }
    });
  });

  it("uses the configured workspace root as the trusted loop repo fallback", async () => {
    await withValidationWorkspaceRoot(async (workspaceRoot) => {
      expect(resolveTrustedLoopRepoRoot(undefined)).toBe(workspaceRoot);
    });
  });

  it("rejects loop repo roots that point outside the trusted workspace", async () => {
    await withValidationWorkspaceRoot(async (workspaceRoot) => {
      const outsideRoot = await mkdtemp(join(tmpdir(), "martin-mcp-validation-untrusted-workspace-"));

      try {
        const escapedPath = join(outsideRoot, "repo");
        await mkdir(escapedPath, { recursive: true });
        expect(() => resolveTrustedLoopRepoRoot(escapedPath, workspaceRoot)).toThrow(
          "Run record points outside the trusted workspace."
        );
      } finally {
        await rm(outsideRoot, { recursive: true, force: true }).catch(() => {});
      }
    });
  });

  it("resolves file selectors relative to an explicit narrowed runsDir", async () => {
    await withValidationRunsRoot(async (runsRoot) => {
      const narrowedRunsRoot = join(runsRoot, "team-a");
      await mkdir(join(narrowedRunsRoot, "loop_001"), { recursive: true });
      await writeFile(join(narrowedRunsRoot, "loop_001", "loop-record.json"), "{}", "utf8");

      const result = validateToolInput("martin_inspect", {
        runsDir: "team-a",
        file: "loop_001/loop-record.json"
      });

      expect(result).toEqual({
        runsDir: narrowedRunsRoot,
        file: join(narrowedRunsRoot, "loop_001", "loop-record.json")
      });
    });
  });

  it("allows inspect to target the run-store root explicitly", () => {
    return withValidationRunsRoot(async (runsRoot) => {
      const result = validateToolInput("martin_inspect", {
        runsDir: "."
      });

      expect(result).toEqual({
        runsDir: runsRoot
      });
    });
  });

  it("rejects ambiguous martin_status selectors", () => {
    expect(() =>
      validateToolInput("martin_status", {
        loopJson: "{}",
        latest: true
      })
    ).toThrow("Provide exactly one");
  });

  it("requires integer values for maxIterations and maxTokens", () => {
    expect(() =>
      validateToolInput("martin_run", {
        objective: "Fix the bug",
        maxIterations: 1.5
      })
    ).toThrow("Invalid maxIterations.");

    expect(() =>
      validateToolInput("martin_run", {
        objective: "Fix the bug",
        maxTokens: 1000.25
      })
    ).toThrow("Invalid maxTokens.");
  });

  it("accepts loopId and latest selectors for martin_status", () => {
    expect(
      validateToolInput("martin_status", {
        loopId: "loop_123"
      })
    ).toEqual({
      loopId: "loop_123"
    });

    expect(
      validateToolInput("martin_status", {
        latest: true
      })
    ).toEqual({
      latest: true
    });
  });

  it("allows missing explicit runsDir for diagnostic run-store surfaces", () => {
    return withValidationRunsRoot(async (runsRoot) => {
      const missingRunsRoot = join(runsRoot, "missing");
      const missingAbsoluteRunsRoot = join(tmpdir(), "martin-mcp-missing-runs-root");

      expect(
        validateToolInput("martin_doctor", {
          runsDir: "missing"
        })
      ).toEqual({
        runsDir: missingRunsRoot
      });

      expect(
        validateToolInput("martin_inspect", {
          runsDir: "missing"
        })
      ).toEqual({
        runsDir: missingRunsRoot
      });

      expect(
        validateToolInput("martin_list_runs", {
          runsDir: "missing"
        })
      ).toEqual({
        runsDir: missingRunsRoot
      });

      expect(
        validateToolInput("martin_triage_runs", {
          runsDir: "missing"
        })
      ).toEqual({
        runsDir: missingRunsRoot
      });

      expect(
        validateToolInput("martin_doctor", {
          runsDir: missingAbsoluteRunsRoot
        })
      ).toEqual({
        runsDir: missingAbsoluteRunsRoot
      });

      expect(() =>
        validateToolInput("martin_doctor", {
          runsDir: "../missing"
        })
      ).toThrow("Invalid runsDir.");
    });
  });

  it("validates doctor and preflight public tool shapes", () => {
    expect(
      validateToolInput("martin_doctor", {
        engine: "codex"
      })
    ).toEqual({
      engine: "codex"
    });

    expect(
      validateToolInput("martin_preflight", {
        objective: "Fix the bug",
        allowedPaths: ["src/**"]
      })
    ).toEqual({
      objective: "Fix the bug",
      allowedPaths: ["src/**"]
    });

    expect(
      validateToolInput("martin_doctor", {
        engine: "gemini"
      })
    ).toEqual({
      engine: "gemini"
    });

    expect(
      validateToolInput("martin_preflight", {
        objective: "Fix the bug",
        engine: "gemini",
        maxUsd: 5
      })
    ).toEqual({
      objective: "Fix the bug",
      engine: "gemini",
      maxUsd: 5
    });

    expect(
      validateToolInput("martin_run", {
        objective: "Fix the bug",
        engine: "gemini",
        maxUsd: 5
      })
    ).toEqual({
      objective: "Fix the bug",
      engine: "gemini",
      maxUsd: 5
    });

    expect(
      validateToolInput("martin_triage_runs", {
        includeHealthy: true,
        limit: 5
      })
    ).toEqual({
      includeHealthy: true,
      limit: 5
    });
  });

  it("rejects non-boolean triage flags", () => {
    expect(() =>
      validateToolInput("martin_triage_runs", {
        includeHealthy: "yes"
      })
    ).toThrow("Invalid includeHealthy.");
  });

  it("rejects attemptIndex values that do not match the public positive-integer contract", () => {
    expect(() =>
      validateToolInput("martin_get_attempt", {
        loopId: "loop_123",
        attemptIndex: 0
      })
    ).toThrow("Invalid attemptIndex.");
  });

  it("scrubs filesystem paths from reflected tool errors", () => {
    expect(
      sanitizeToolErrorMessage(
        new Error("Failed to load C:\\secret\\repo\\.martin\\policy.rego")
      )
    ).toBe("Tool execution failed.");
  });

  it("keeps discovery metadata internally consistent", () => {
    for (const starterTool of MARTIN_STARTER_TOOL_NAMES) {
      expect(MARTIN_TOOL_NAMES).toContain(starterTool);
    }

    expect(MARTIN_RESOURCE_URIS).toContain("martin://runs/triage");
    expect(MARTIN_RESOURCE_TEMPLATE_URIS).toContain("martin://runs/{loopId}/verification");
    expect(MARTIN_PROMPT_NAMES).toContain("martin_triage_run_store");
  });

  it("preserves typed resource and prompt errors through server handlers", async () => {
    const server = createMartinMcpServer() as unknown as ServerWithRequestHandlers;
    const readResource = server._requestHandlers.get("resources/read");
    const getPrompt = server._requestHandlers.get("prompts/get");

    await expect(
      readResource?.(
        {
          method: "resources/read",
          params: { uri: "martin://unknown" }
        },
        {}
      )
    ).rejects.toMatchObject({
      name: "MartinToolError",
      code: "invalid_arguments",
      suggestion: "Use resources/list or resources/templates/list to discover Martin resource URIs."
    });

    await expect(
      getPrompt?.(
        {
          method: "prompts/get",
          params: {
            name: "martin_governed_coding_kickoff",
            arguments: {}
          }
        },
        {}
      )
    ).rejects.toMatchObject({
      name: "MartinToolError",
      code: "invalid_arguments",
      suggestion: "Provide 'objective' when calling this Martin prompt."
    });
  });

  it("documents the same positive attemptIndex contract in the public schema", async () => {
    const testsDir = dirname(fileURLToPath(import.meta.url));
    const serverSource = await readFile(join(testsDir, "../src/server.ts"), "utf8");
    const normalizedServerSource = serverSource.replace(/\r\n/g, "\n");

    expect(normalizedServerSource).toContain('name: "martin_get_attempt"');
    expect(normalizedServerSource).toMatch(/attemptIndex:\s*\{\s*type:\s*"integer",\s*minimum:\s*1,/m);
  });

  it("blocks martin_run before spend when the MCP receipt chain is missing", async () => {
    await withValidationRunsRoot(async () => {
      await withValidationWorkspaceRoot(async () => {
        const server = createMartinMcpServer() as unknown as ServerWithRequestHandlers;
        const callTool = server._requestHandlers.get("tools/call");

        const result = await callTool?.(
          {
            method: "tools/call",
            params: {
              name: "martin_run",
              arguments: {
                objective: "Repair the failing MCP lane",
                engine: "codex",
                verificationPlan: ["pnpm --filter @martinloop/mcp test"],
                maxUsd: 2,
                maxIterations: 1
              }
            }
          },
          {}
        );

        expect(result).toMatchObject({
          isError: true,
          _meta: {
            "martinloop/errorCode": "policy_blocked",
            "martinloop/errorCategory": "policy_blocked"
          }
        });
      });
    });
  });

  it("accepts a matching doctor-plan-preflight receipt chain for martin_run when maxUsd is below the default soft limit", async () => {
    await withValidationRunsRoot(async () => {
      await withValidationWorkspaceRoot(async (workspaceRoot) => {
        const previousLive = process.env.MARTIN_LIVE;
        process.env.MARTIN_LIVE = "false";
        const verifierCalls: Array<{ command: string; args: readonly string[]; options?: SpawnOptions }> = [];
        __setProofModeVerifierSpawnImplForTests(createImmediateSpawn(verifierCalls));

        try {
          await withMemoryRunStore(async (memoryRunsRoot) => {
            __setRunStoreOverrideForTests(createMemoryRunStore(memoryRunsRoot));

            const server = createMartinMcpServer() as unknown as ServerWithRequestHandlers;
            const callTool = server._requestHandlers.get("tools/call");
            if (!callTool) {
              throw new Error("Expected tools/call request handler.");
            }

            const doctorResult = await callTool(
              {
                method: "tools/call",
                params: {
                  name: "martin_doctor",
                  arguments: {
                    workingDirectory: workspaceRoot,
                    engine: "claude"
                  }
                }
              },
              {}
            );
            expect((doctorResult as { isError?: boolean }).isError).not.toBe(true);

            const planResult = await callTool(
              {
                method: "tools/call",
                params: {
                  name: "martin_plan",
                  arguments: {
                    objective: "Summarize the current runtime state",
                    workingDirectory: workspaceRoot
                  }
                }
              },
              {}
            );
            expect((planResult as { isError?: boolean }).isError).not.toBe(true);

            const preflightResult = await callTool(
              {
                method: "tools/call",
                params: {
                  name: "martin_preflight",
                  arguments: {
                    objective: "Summarize the current runtime state",
                    workingDirectory: workspaceRoot,
                    engine: "claude",
                    verificationPlan: ["node --version"],
                    maxUsd: 1,
                    maxIterations: 1,
                    allowedPaths: ["src/**"],
                    deniedPaths: ["docs/**"]
                  }
                }
              },
              {}
            );

            expect((preflightResult as { isError?: boolean }).isError).not.toBe(true);
            expect(JSON.parse(readToolText(preflightResult)).normalized.budget.softLimitUsd).toBe(1);

            const runResult = await callTool(
              {
                method: "tools/call",
                params: {
                  name: "martin_run",
                  arguments: {
                    objective: "Summarize the current runtime state",
                    workingDirectory: workspaceRoot,
                    engine: "claude",
                    verificationPlan: ["node --version"],
                    maxUsd: 1,
                    maxIterations: 1,
                    allowedPaths: ["src/**"],
                    deniedPaths: ["docs/**"]
                  }
                }
              },
              {}
            );

            expect((runResult as { isError?: boolean }).isError).not.toBe(true);
            expect(JSON.parse(readToolText(runResult))).toMatchObject({
              budget: {
                maxUsd: 1,
                softLimitUsd: 1,
                maxIterations: 1
              }
            });
            expect(verifierCalls).toHaveLength(1);
            expect(verifierCalls[0]?.command).toBe("node");
            expect(verifierCalls[0]?.args).toEqual(["--version"]);
          });
        } finally {
          if (previousLive === undefined) {
            delete process.env.MARTIN_LIVE;
          } else {
            process.env.MARTIN_LIVE = previousLive;
          }
        }
      });
    });
  });

  it("accepts a matching doctor-plan-preflight receipt chain when no path allow/deny filters are provided", async () => {
    await withValidationRunsRoot(async () => {
      await withValidationWorkspaceRoot(async (workspaceRoot) => {
        const previousLive = process.env.MARTIN_LIVE;
        process.env.MARTIN_LIVE = "false";
        const verifierCalls: Array<{ command: string; args: readonly string[]; options?: SpawnOptions }> = [];
        __setProofModeVerifierSpawnImplForTests(createImmediateSpawn(verifierCalls));

        try {
          await withMemoryRunStore(async (memoryRunsRoot) => {
            __setRunStoreOverrideForTests(createMemoryRunStore(memoryRunsRoot));

            const server = createMartinMcpServer() as unknown as ServerWithRequestHandlers;
            const callTool = server._requestHandlers.get("tools/call");
            if (!callTool) {
              throw new Error("Expected tools/call request handler.");
            }

            const objective = "Summarize the current runtime state";
            const verificationPlan = ["node --version"];

            await callTool(
              {
                method: "tools/call",
                params: {
                  name: "martin_doctor",
                  arguments: { workingDirectory: workspaceRoot, engine: "claude" }
                }
              },
              {}
            );
            await callTool(
              {
                method: "tools/call",
                params: {
                  name: "martin_plan",
                  arguments: { objective, workingDirectory: workspaceRoot }
                }
              },
              {}
            );
            const preflightResult = await callTool(
              {
                method: "tools/call",
                params: {
                  name: "martin_preflight",
                  arguments: {
                    objective,
                    workingDirectory: workspaceRoot,
                    engine: "claude",
                    verificationPlan,
                    maxUsd: 1,
                    maxIterations: 1
                  }
                }
              },
              {}
            );
            expect((preflightResult as { isError?: boolean }).isError).not.toBe(true);

            const runResult = await callTool(
              {
                method: "tools/call",
                params: {
                  name: "martin_run",
                  arguments: {
                    objective,
                    workingDirectory: workspaceRoot,
                    engine: "claude",
                    verificationPlan,
                    maxUsd: 1,
                    maxIterations: 1
                  }
                }
              },
              {}
            );

            expect((runResult as { isError?: boolean }).isError).not.toBe(true);
            expect(verifierCalls).toHaveLength(1);
            expect(verifierCalls[0]?.command).toBe("node");
            expect(verifierCalls[0]?.args).toEqual(["--version"]);
          });
        } finally {
          if (previousLive === undefined) {
            delete process.env.MARTIN_LIVE;
          } else {
            process.env.MARTIN_LIVE = previousLive;
          }
        }
      });
    });
  });
});
