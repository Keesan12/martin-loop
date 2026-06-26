/**
 * Tests for the OpenAI-compatible adapter.
 * Uses a local mock HTTP server to avoid any real API calls.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, afterEach, vi } from "vitest";
import { createLoopRecord } from "@martin/contracts";
import { createOpenAiCompatibleAdapter } from "../src/openai-compatible.js";

// ---------------------------------------------------------------------------
// Mock server helpers
// ---------------------------------------------------------------------------

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
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => server.close()
      });
    });
  });
}

function makeRequest(overrides = {}) {
  const loop = createLoopRecord({
    workspaceId: "ws_test",
    projectId: "proj_test",
    task: {
      title: "Fix the off-by-one error",
      objective: "Correct the index in counter.ts so result is 10 not 9.",
      verificationPlan: []
    },
    budget: { maxUsd: 5, softLimitUsd: 3, maxIterations: 3, maxTokens: 10_000 },
    cost: { actualUsd: 0, avoidedUsd: 0, tokensIn: 0, tokensOut: 0 },
    ...overrides
  });

  return {
    loopId: loop.loopId,
    attemptId: "att_test",
    context: {
      taskTitle: loop.task.title,
      objective: loop.task.objective,
      verificationPlan: loop.task.verificationPlan,
      verificationStack: undefined,
      focus: undefined,
      remainingBudgetUsd: loop.budget.maxUsd,
      remainingIterations: loop.budget.maxIterations,
      remainingTokens: loop.budget.maxTokens
    },
    previousAttempts: []
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createOpenAiCompatibleAdapter", () => {
  let mockClose: (() => void) | undefined;

  afterEach(() => {
    mockClose?.();
    mockClose = undefined;
  });

  it("sends the objective to /v1/chat/completions and returns completed on verifier pass", async () => {
    let capturedBody: unknown;
    const { url, close } = await startMockServer((_req, rawBody) => {
      capturedBody = JSON.parse(rawBody);
      return {
        body: {
          choices: [{ message: { role: "assistant", content: "Fixed counter.ts index calculation." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 120, completion_tokens: 45, total_tokens: 165 }
        }
      };
    });
    mockClose = close;

    const adapter = createOpenAiCompatibleAdapter({
      baseUrl: url,
      model: "test-model",
      apiKey: "sk-test"
    });

    const result = await adapter.execute(makeRequest() as any);

    // Correct endpoint called
    expect((capturedBody as any).model).toBe("test-model");
    expect((capturedBody as any).messages).toHaveLength(2); // system + user
    expect((capturedBody as any).messages[1]?.content).toContain("Fix the off-by-one error");

    // Result shape
    expect(result.status).toBe("completed");
    expect(result.usage.tokensIn).toBe(120);
    expect(result.usage.tokensOut).toBe(45);
  });

  it("returns failed when the API returns an error status", async () => {
    const { url, close } = await startMockServer(() => ({
      status: 429,
      body: { error: { message: "Rate limit exceeded", type: "rate_limit_error" } }
    }));
    mockClose = close;

    const adapter = createOpenAiCompatibleAdapter({ baseUrl: url, model: "test-model" });
    const result = await adapter.execute(makeRequest() as any);

    expect(result.status).toBe("failed");
    expect(result.failure?.message).toContain("Rate limit exceeded");
  });

  it("clears the timeout when the request fails before parsing a response", async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

    try {
      const adapter = createOpenAiCompatibleAdapter({
        baseUrl: "http://127.0.0.1:1",
        model: "test-model",
        fetchImpl: async () => {
          throw new Error("network exploded");
        }
      });

      const result = await adapter.execute(makeRequest() as any);

      expect(result.status).toBe("failed");
      expect(result.failure?.message).toContain("network exploded");
      expect(clearTimeoutSpy).toHaveBeenCalled();
    } finally {
      clearTimeoutSpy.mockRestore();
    }
  });

  it("returns failed when the model returns an empty response", async () => {
    const { url, close } = await startMockServer(() => ({
      body: {
        choices: [{ message: { role: "assistant", content: "" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 50, completion_tokens: 0 }
      }
    }));
    mockClose = close;

    const adapter = createOpenAiCompatibleAdapter({ baseUrl: url, model: "test-model" });
    const result = await adapter.execute(makeRequest() as any);

    expect(result.status).toBe("failed");
    expect(result.failure?.message).toBe("empty_response");
  });

  it("skips git diff scans when no verification steps are configured", async () => {
    const { url, close } = await startMockServer(() => ({
      body: {
        choices: [{ message: { role: "assistant", content: "No repo required." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 50, completion_tokens: 10 }
      }
    }));
    mockClose = close;
    const workingDirectory = await mkdtemp(join(tmpdir(), "martin-openai-no-git-"));

    try {
      const adapter = createOpenAiCompatibleAdapter({
        baseUrl: url,
        model: "test-model",
        workingDirectory
      });

      const result = await adapter.execute(makeRequest() as any);

      expect(result.status).toBe("completed");
      expect(result.execution?.changedFiles).toEqual([]);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it("blocks on budget preflight when projected cost exceeds remaining budget", async () => {
    const { url, close } = await startMockServer(() => ({ body: {} }));
    mockClose = close;

    const adapter = createOpenAiCompatibleAdapter({
      baseUrl: url,
      model: "test-model",
      // Set a very expensive model to force preflight failure
      apiKey: ""
    });

    // Override known pricing to make it expensive
    const request = makeRequest() as any;
    // remainingBudgetUsd is $5 — with blended pricing and a short prompt this won't trigger.
    // Force trigger by setting a tiny remaining budget.
    request.context.remainingBudgetUsd = 0.000001;

    const result = await adapter.execute(request);

    expect(result.status).toBe("failed");
    expect(result.failure?.message).toBe("budget_preflight_exceeded");
  });

  it("adds OpenRouter-specific headers when baseUrl contains openrouter", async () => {
    let capturedHeaders: Record<string, string | string[] | undefined> = {};
    const { url, close } = await startMockServer((req) => {
      capturedHeaders = req.headers as Record<string, string | string[] | undefined>;
      return {
        body: {
          choices: [{ message: { role: "assistant", content: "Done." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5 }
        }
      };
    });
    mockClose = close;

    const adapter = createOpenAiCompatibleAdapter({
      baseUrl: `${url}/openrouter`,
      model: "deepseek/deepseek-chat",
      apiKey: "sk-or-test"
    });

    const result = await adapter.execute(makeRequest() as any);
    expect(result.status).toBe("completed");
    expect(capturedHeaders["http-referer"]).toBe("https://martinloop.com");
    expect(capturedHeaders["x-title"]).toBe("MartinLoop");
  });

  it("uses known model pricing for deepseek/deepseek-chat", async () => {
    const { url, close } = await startMockServer(() => ({
      body: {
        choices: [{ message: { role: "assistant", content: "Fixed." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1000, completion_tokens: 500 }
      }
    }));
    mockClose = close;

    const adapter = createOpenAiCompatibleAdapter({
      baseUrl: url,
      model: "deepseek/deepseek-chat"
    });

    const result = await adapter.execute(makeRequest() as any);

    // deepseek pricing: $0.00027/1K input + $0.0011/1K output
    // 1000 input tokens = $0.00027, 500 output tokens = $0.00055 → $0.00082
    expect(result.status).toBe("completed");
    expect(result.usage.actualUsd).toBeCloseTo(0.00027 + 0.00055, 5);
  });

  it("exposes correct adapterId and metadata", () => {
    const adapter = createOpenAiCompatibleAdapter({
      baseUrl: "http://localhost:11434",
      model: "llama3.3"
    });

    expect(adapter.adapterId).toBe("openai-compatible:llama3.3");
    expect(adapter.metadata.model).toBe("llama3.3");
    expect(adapter.metadata.transport).toBe("http");
    expect(adapter.kind).toBe("direct-provider");
  });

  it("defaults to the hosted OpenAI endpoint and model when config is omitted", async () => {
    let capturedUrl = "";
    const adapter = createOpenAiCompatibleAdapter({
      fetchImpl: async (input) => {
        capturedUrl = String(input);
        return new Response(JSON.stringify({
          choices: [{ message: { role: "assistant", content: "Fixed." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5 }
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
    });

    const result = await adapter.execute(makeRequest() as any);

    expect(result.status).toBe("completed");
    expect(adapter.adapterId).toBe("openai-compatible:gpt-4.1-mini");
    expect(adapter.metadata.model).toBe("gpt-4.1-mini");
    expect(capturedUrl).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("uses the runtime API key when options.apiKey is unset", async () => {
    let capturedHeaders: Record<string, string | string[] | undefined> = {};
    const previousApiKey = process.env.MARTIN_OPENAI_API_KEY;

    try {
      process.env.MARTIN_OPENAI_API_KEY = "sk-env-fallback";
      const { url, close } = await startMockServer((req) => {
        capturedHeaders = req.headers as Record<string, string | string[] | undefined>;
        return {
          body: {
            choices: [{ message: { role: "assistant", content: "Fixed." }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 5 }
          }
        };
      });
      mockClose = close;

      const adapter = createOpenAiCompatibleAdapter({ baseUrl: url, model: "test-model" });
      const result = await adapter.execute(makeRequest() as any);

      expect(result.status).toBe("completed");
      expect(capturedHeaders["authorization"]).toBe("Bearer sk-env-fallback");
    } finally {
      if (previousApiKey === undefined) {
        delete process.env.MARTIN_OPENAI_API_KEY;
      } else {
        process.env.MARTIN_OPENAI_API_KEY = previousApiKey;
      }
    }
  });

  it("retries on 429 rate-limit and succeeds on the subsequent attempt", async () => {
    // Regression: before the fix, a 429 immediately failed the run. Now it retries
    // with exponential backoff and succeeds if the server recovers.
    let callCount = 0;
    const { url, close } = await startMockServer((_req, _body) => {
      callCount++;
      if (callCount === 1) {
        // First call: rate-limited
        return { status: 429, body: { error: { message: "rate limit exceeded", type: "rate_limit_error" } } };
      }
      // Second call: success
      return {
        status: 200,
        body: {
          choices: [{ message: { role: "assistant", content: "// Fixed\nconst x = 1;" } }],
          usage: { prompt_tokens: 100, completion_tokens: 50 }
        }
      };
    });
    mockClose = close;

    const adapter = createOpenAiCompatibleAdapter({
      baseUrl: url,
      model: "test-model",
      workingDirectory: process.cwd()
    });
    const result = await adapter.execute(makeRequest() as any);

    expect(callCount).toBe(2);
    // After a successful retry, result is not failed — the rate-limit error was transient.
    expect(result.status).not.toBe("failed");
  }, 15_000);

  it("fails immediately on 401 auth error without retrying", async () => {
    // Auth errors are permanent — retrying would waste time and potentially expose the key.
    let callCount = 0;
    const { url, close } = await startMockServer(() => {
      callCount++;
      return { status: 401, body: { error: { message: "invalid api key", type: "authentication_error" } } };
    });
    mockClose = close;

    const adapter = createOpenAiCompatibleAdapter({ baseUrl: url, model: "test-model" });
    const result = await adapter.execute(makeRequest() as any);

    expect(callCount).toBe(1);
    expect(result.status).toBe("failed");
  });

  it("retries on 503 server error up to max retries then fails", async () => {
    let callCount = 0;
    const { url, close } = await startMockServer(() => {
      callCount++;
      return { status: 503, body: { error: { message: "service unavailable" } } };
    });
    mockClose = close;

    const adapter = createOpenAiCompatibleAdapter({ baseUrl: url, model: "test-model" });
    const result = await adapter.execute(makeRequest() as any);

    // Should have tried MAX_RETRIES=3 times before giving up
    expect(callCount).toBe(3);
    expect(result.status).toBe("failed");
    // Summary includes the error message body from the final attempt
    expect(result.summary).toContain("service unavailable");
  }, 20_000);
});
