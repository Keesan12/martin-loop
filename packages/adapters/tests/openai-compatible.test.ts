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
import {
  createOpenAiCompatibleAdapter,
  resolveOpenAiCompatibleRuntimeConfig
} from "../src/openai-compatible.js";

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
  it("fails closed for a metered model without authoritative pricing", () => {
    expect(() => createOpenAiCompatibleAdapter({
      baseUrl: "https://api.example.test",
      apiKey: "sk-test",
      model: "provider/unknown-model"
    })).toThrow(/PRICING_CONFIGURATION_REQUIRED/u);
  });

  it("fails closed for an explicitly unknown billing mode without authoritative pricing", () => {
    expect(() => createOpenAiCompatibleAdapter({
      baseUrl: "https://api.example.test",
      model: "provider/unknown-model",
      billingMode: "unknown"
    })).toThrow(/PRICING_CONFIGURATION_REQUIRED/u);
  });

  it("uses an explicit unknown-model price for metadata and its own budget preflight", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const adapter = createOpenAiCompatibleAdapter({
      baseUrl: "https://api.example.test",
      apiKey: "sk-test",
      model: "provider/unknown-model",
      pricePerMTokenUsd: 40,
      fetchImpl
    });
    const request = makeRequest() as any;
    request.context.remainingBudgetUsd = 0.001;

    expect(adapter.metadata.budgetPreflight?.pricePerMTokenUsd).toBe(40);
    const result = await adapter.execute(request);
    expect(result.failure?.message).toBe("budget_preflight_exceeded");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("settles an explicit unknown-model price against provider-reported tokens", async () => {
    const result = await createOpenAiCompatibleAdapter({
      baseUrl: "https://api.example.test",
      model: "provider/unknown-model",
      billingMode: "unknown",
      pricePerMTokenUsd: 40,
      fetchImpl: async () => new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "Done." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 50 }
      }), { status: 200, headers: { "Content-Type": "application/json" } })
    }).execute(makeRequest() as any);

    expect(result.usage.actualUsd).toBeCloseTo(0.006, 6);
    expect(result.usage.provenance).toBe("calculated");
    expect(result.usage.providerSettlement).toMatchObject({
      pricingSource: "blended_fallback",
      pricingVersion: "configured-price-per-m-token"
    });
  });

  it("publishes catalog pricing for metered models and explicit zero for local unmetered models", () => {
    const metered = createOpenAiCompatibleAdapter({
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      model: "gpt-6-astra"
    });
    const local = createOpenAiCompatibleAdapter({
      baseUrl: "http://127.0.0.1:11434",
      model: "gpt-6-astra"
    });

    expect(metered.metadata.budgetPreflight?.pricePerMTokenUsd).toBe(75);
    expect(local.metadata.budgetPreflight?.pricePerMTokenUsd).toBe(0);
  });

  it("lets an explicit billing option override an invalid environment value", () => {
    const previous = process.env.MARTIN_OPENAI_BILLING_MODE;
    process.env.MARTIN_OPENAI_BILLING_MODE = "invalid-mode";
    try {
      const adapter = createOpenAiCompatibleAdapter({
        baseUrl: "http://127.0.0.1:11434",
        model: "gpt-6.1-sol",
        billingMode: "local_unmetered"
      });
      expect(adapter.metadata.budgetPreflight?.pricePerMTokenUsd).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.MARTIN_OPENAI_BILLING_MODE;
      else process.env.MARTIN_OPENAI_BILLING_MODE = previous;
    }
  });

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
      apiKey: "sk-test",
      pricePerMTokenUsd: 3
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

  it("does not duplicate the v1 segment when the configured base URL already includes it", async () => {
    let requestedPath: string | undefined;
    const { url, close } = await startMockServer((req) => {
      requestedPath = req.url;
      return {
        body: {
          choices: [{ message: { role: "assistant", content: "Completed." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5 }
        }
      };
    });
    mockClose = close;

    const result = await createOpenAiCompatibleAdapter({
      baseUrl: `${url}/v1`,
      model: "test-model"
    }).execute(makeRequest() as any);

    expect(result.status).toBe("completed");
    expect(requestedPath).toBe("/v1/chat/completions");
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
    const adapter = createOpenAiCompatibleAdapter({
      baseUrl: "https://api.example.test",
      model: "test-model",
      pricePerMTokenUsd: 3,
      fetchImpl: async () => new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 50, completion_tokens: 0 }
      }), { status: 200, headers: { "Content-Type": "application/json" } })
    });
    const result = await adapter.execute(makeRequest() as any);

    expect(result.status).toBe("failed");
    expect(result.failure?.message).toBe("empty_response");
    expect(result.usage.provenance).toBe("calculated");
    expect(result.usage.actualUsd).toBeGreaterThan(0);
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
      expect(result.verification.passed).toBe(false);
      expect(result.verification.summary).toContain("No verification commands");
      expect(result.execution?.changedFiles).toEqual([]);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it("forwards request cancellation to verifier execution", async () => {
    const workingDirectory = await mkdtemp(join(tmpdir(), "martin-openai-verifier-abort-"));
    const controller = new AbortController();
    const fetchImpl: typeof fetch = async () => {
      controller.abort("cancelled-before-verifier");
      return new Response(JSON.stringify({
        choices: [{
          message: {
            role: "assistant",
            content: JSON.stringify({
              summary: "prepared change",
              edits: [{ path: "result.txt", content: "done\n" }],
              deletions: []
            })
          },
          finish_reason: "stop"
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5 }
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    };

    try {
      const adapter = createOpenAiCompatibleAdapter({
        baseUrl: "http://127.0.0.1:1",
        model: "test-model",
        workingDirectory,
        fetchImpl
      });
      const request = makeRequest({
        task: {
          title: "Apply then verify",
          objective: "Create result.txt and verify it.",
          verificationPlan: ["tool verify"]
        }
      }) as any;
      request.workspaceId = "ws_test";
      request.signal = controller.signal;

      const result = await adapter.execute(request);

      expect(result.status).toBe("failed");
      expect(result.verification.steps).toEqual([
        expect.objectContaining({ launched: false, completed: false })
      ]);
    } finally {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  });

  it("aborts an in-flight provider request when the parent signal fires", async () => {
    const controller = new AbortController();
    let observedFetchSignal: AbortSignal | undefined;
    const fetchStarted = Promise.withResolvers<void>();
    const fetchImpl: typeof fetch = async (_input, init) => {
      observedFetchSignal = init?.signal ?? undefined;
      fetchStarted.resolve();
      await new Promise<void>((resolve) => {
        if (observedFetchSignal?.aborted) resolve();
        else observedFetchSignal?.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new DOMException("parent cancelled", "AbortError");
    };
    const adapter = createOpenAiCompatibleAdapter({
      baseUrl: "http://127.0.0.1:1",
      model: "gpt-6.1-sol",
      fetchImpl
    });
    const request = makeRequest() as any;
    request.signal = controller.signal;

    const execution = adapter.execute(request);
    await fetchStarted.promise;
    controller.abort(new Error("parent cancelled"));
    const result = await execution;

    expect(observedFetchSignal?.aborted).toBe(true);
    expect(result.status).toBe("failed");
    expect(result.summary).toMatch(/cancel/i);
  });

  it("aborts a retry delay immediately instead of launching another request", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      error: { message: "rate limited" }
    }), {
      status: 429,
      headers: { "Content-Type": "application/json" }
    }));
    const adapter = createOpenAiCompatibleAdapter({
      baseUrl: "http://127.0.0.1:1",
      model: "test-model",
      fetchImpl
    });
    const request = makeRequest() as any;
    request.signal = controller.signal;

    const execution = adapter.execute(request);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    controller.abort(new Error("parent cancelled retry"));
    const result = await execution;

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.status).toBe("failed");
    expect(result.summary).toMatch(/cancel/i);
  });

  it("closes the parent-abort race while registering a provider request listener", async () => {
    const controller = new AbortController();
    const originalAddEventListener = controller.signal.addEventListener.bind(controller.signal);
    const registration = vi.spyOn(controller.signal, "addEventListener").mockImplementation((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions
    ) => {
      if (type === "abort" && !controller.signal.aborted) {
        controller.abort(new Error("cancelled while registering provider listener"));
      }
      originalAddEventListener(type, listener, options);
    });
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      if (init?.signal?.aborted) throw new DOMException("parent cancelled", "AbortError");
      return new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const adapter = createOpenAiCompatibleAdapter({
      baseUrl: "http://127.0.0.1:1",
      model: "test-model",
      fetchImpl
    });
    const request = makeRequest() as any;
    request.signal = controller.signal;

    try {
      const result = await adapter.execute(request);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(result.status).toBe("failed");
      expect(result.summary).toMatch(/cancel/i);
    } finally {
      registration.mockRestore();
    }
  });

  it("closes the parent-abort race while registering a retry-delay listener", async () => {
    const controller = new AbortController();
    const originalAddEventListener = controller.signal.addEventListener.bind(controller.signal);
    let abortRegistrations = 0;
    const registration = vi.spyOn(controller.signal, "addEventListener").mockImplementation((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions
    ) => {
      if (type === "abort") {
        abortRegistrations += 1;
        if (abortRegistrations === 2 && !controller.signal.aborted) {
          controller.abort(new Error("cancelled while registering retry listener"));
        }
      }
      originalAddEventListener(type, listener, options);
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      error: { message: "rate limited" }
    }), { status: 429, headers: { "Content-Type": "application/json" } }));
    const adapter = createOpenAiCompatibleAdapter({
      baseUrl: "http://127.0.0.1:1",
      model: "test-model",
      fetchImpl
    });
    const request = makeRequest() as any;
    request.signal = controller.signal;

    try {
      const result = await adapter.execute(request);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(result.status).toBe("failed");
      expect(result.summary).toMatch(/cancel/i);
    } finally {
      registration.mockRestore();
    }
  });

  it("blocks on budget preflight when projected cost exceeds remaining budget", async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    const adapter = createOpenAiCompatibleAdapter({
      baseUrl: "https://api.example.test",
      model: "gpt-6.1-sol",
      apiKey: "sk-test",
      fetchImpl
    });

    // Override known pricing to make it expensive
    const request = makeRequest() as any;
    // remainingBudgetUsd is $5 — with blended pricing and a short prompt this won't trigger.
    // Force trigger by setting a tiny remaining budget.
    request.context.remainingBudgetUsd = 0.000001;

    const result = await adapter.execute(request);

    expect(result.status).toBe("failed");
    expect(result.failure?.message).toBe("budget_preflight_exceeded");
    expect(fetchImpl).not.toHaveBeenCalled();
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
      apiKey: ["sk", "or", "test"].join("-"),
      pricePerMTokenUsd: 3
    });

    const result = await adapter.execute(makeRequest() as any);
    expect(result.status).toBe("completed");
    expect(capturedHeaders["http-referer"]).toBe("https://martinloop.com");
    expect(capturedHeaders["x-title"]).toBe("MartinLoop");
  });

  it("settles official model pricing from the provider catalog", async () => {
    const adapter = createOpenAiCompatibleAdapter({
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-6.1-sol",
      apiKey: "sk-test",
      fetchImpl: async () => new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "Fixed." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1000, completion_tokens: 500 }
      }), { status: 200, headers: { "Content-Type": "application/json" } })
    });

    const result = await adapter.execute(makeRequest() as any);

    expect(result.status).toBe("completed");
    expect(result.usage.actualUsd).toBeCloseTo(0.002 + 0.005, 6);
    expect(result.usage.provenance).toBe("calculated");
    expect(result.usage.providerSettlement).toMatchObject({
      model: "gpt-6.1-sol",
      modelSource: "explicit_override",
      pricingSource: "static_catalog",
      pricingVersion: "official-provider-pricing@2026-11-03"
    });
  });

  it("does not charge local unmetered providers or reject them on synthetic dollar estimates", async () => {
    const { url, close } = await startMockServer(() => ({
      body: {
        choices: [{ message: { role: "assistant", content: "Local model completed." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1000, completion_tokens: 500 }
      }
    }));
    mockClose = close;

    const request = makeRequest() as any;
    request.context.remainingBudgetUsd = 0.000001;

    const result = await createOpenAiCompatibleAdapter({
      baseUrl: url,
      model: "local/custom-model"
    }).execute(request);

    expect(result.status).toBe("completed");
    expect(result.usage.actualUsd).toBe(0);
    expect(result.usage.estimatedUsd).toBeUndefined();
    expect(result.usage.providerSettlement).toMatchObject({
      billingMode: "local_unmetered",
      pricingSource: "none"
    });
  });

  it("does not treat a remote hostname containing localhost as local unmetered", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "Remote model completed." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1000, completion_tokens: 500 }
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const request = makeRequest() as any;
    request.context.remainingBudgetUsd = 0.000001;

    const result = await createOpenAiCompatibleAdapter({
      baseUrl: "https://localhost.example.com",
      model: "gpt-6.1-sol",
      fetchImpl
    }).execute(request);

    expect(result.status).toBe("failed");
    expect(result.failure?.message).toBe("budget_preflight_exceeded");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("honors explicit metered billing authority for a loopback proxy", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const request = makeRequest() as any;
    request.context.remainingBudgetUsd = 0.000001;

    const result = await createOpenAiCompatibleAdapter({
      baseUrl: "http://127.0.0.1:11434",
      model: "gpt-6.1-sol",
      billingMode: "metered_api",
      fetchImpl
    }).execute(request);

    expect(result.status).toBe("failed");
    expect(result.failure?.message).toBe("budget_preflight_exceeded");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("recognizes IPv6 loopback as local unmetered", async () => {
    const request = makeRequest() as any;
    request.context.remainingBudgetUsd = 0.000001;

    const result = await createOpenAiCompatibleAdapter({
      baseUrl: "http://[::1]:11434",
      model: "local/ipv6-model",
      fetchImpl: async () => new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "IPv6 local model completed." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1000, completion_tokens: 500 }
      }), { status: 200, headers: { "Content-Type": "application/json" } })
    }).execute(request);

    expect(result.status).toBe("completed");
    expect(result.usage.actualUsd).toBe(0);
    expect(result.usage.providerSettlement?.billingMode).toBe("local_unmetered");
  });

  it("marks cost estimated when the provider omits token usage", async () => {
    const result = await createOpenAiCompatibleAdapter({
      baseUrl: "https://api.example.test",
      model: "gpt-6.1-sol",
      fetchImpl: async () => new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "Fixed." }, finish_reason: "stop" }]
      }), { status: 200, headers: { "Content-Type": "application/json" } })
    }).execute(makeRequest() as any);

    expect(result.usage.provenance).toBe("estimated");
    expect(result.usage.estimatedUsd).toBe(result.usage.actualUsd);
  });

  it("marks cost estimated when the provider reports only partial token usage", async () => {
    const result = await createOpenAiCompatibleAdapter({
      baseUrl: "https://api.example.test",
      model: "gpt-6.1-sol",
      fetchImpl: async () => new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "Fixed." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100 }
      }), { status: 200, headers: { "Content-Type": "application/json" } })
    }).execute(makeRequest() as any);

    expect(result.usage.tokensIn).toBe(100);
    expect(result.usage.tokensOut).toBeGreaterThan(0);
    expect(result.usage.provenance).toBe("estimated");
    expect(result.usage.estimatedUsd).toBe(result.usage.actualUsd);
  });

  it("keeps unknown local-unmetered settlement unavailable instead of fabricating pricing", async () => {
    const result = await createOpenAiCompatibleAdapter({
      baseUrl: "http://localhost:11434",
      model: "provider/unknown-model",
      fetchImpl: async () => new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "Fixed." }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 50 }
      }), { status: 200, headers: { "Content-Type": "application/json" } })
    }).execute(makeRequest() as any);

    expect(result.usage.actualUsd).toBe(0);
    expect(result.usage.provenance).toBe("unavailable");
    expect(result.usage.estimatedUsd).toBeUndefined();
    expect(result.usage.providerSettlement?.pricingSource).toBe("none");
  });

  it("keeps empty-response cost unavailable for an unknown local model", async () => {
    const result = await createOpenAiCompatibleAdapter({
      baseUrl: "http://localhost:11434",
      model: "provider/unknown-model",
      fetchImpl: async () => new Response(JSON.stringify({
        choices: [{ message: { role: "assistant", content: "" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 0 }
      }), { status: 200, headers: { "Content-Type": "application/json" } })
    }).execute(makeRequest() as any);

    expect(result.status).toBe("failed");
    expect(result.failure?.message).toBe("empty_response");
    expect(result.usage.actualUsd).toBe(0);
    expect(result.usage.provenance).toBe("unavailable");
    expect(result.usage.estimatedUsd).toBeUndefined();
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

  it("requires explicit or provider-configured model authority", () => {
    const previousModel = process.env.MARTIN_OPENAI_MODEL;
    try {
      delete process.env.MARTIN_OPENAI_MODEL;
      expect(() => createOpenAiCompatibleAdapter({})).toThrow("MODEL_CONFIGURATION_REQUIRED");
    } finally {
      if (previousModel === undefined) delete process.env.MARTIN_OPENAI_MODEL;
      else process.env.MARTIN_OPENAI_MODEL = previousModel;
    }
  });

  it("reads explicit billing authority from the runtime environment", () => {
    expect(resolveOpenAiCompatibleRuntimeConfig({
      MARTIN_OPENAI_BILLING_MODE: "metered_api"
    })).toMatchObject({ billingMode: "metered_api" });
  });

  it("rejects invalid billing authority from the runtime environment", () => {
    expect(() => resolveOpenAiCompatibleRuntimeConfig({
      MARTIN_OPENAI_BILLING_MODE: "free-ish"
    })).toThrow(/INVALID_OPENAI_BILLING_MODE/u);
  });

  it("reads custom-model pricing authority from the runtime environment", () => {
    expect(resolveOpenAiCompatibleRuntimeConfig({
      MARTIN_OPENAI_PRICE_PER_M_TOKEN_USD: "12.5"
    })).toMatchObject({ pricePerMTokenUsd: 12.5 });
  });

  it("lets an explicit price override an invalid environment value", () => {
    const previous = process.env.MARTIN_OPENAI_PRICE_PER_M_TOKEN_USD;
    process.env.MARTIN_OPENAI_PRICE_PER_M_TOKEN_USD = "not-a-price";
    try {
      const adapter = createOpenAiCompatibleAdapter({
        baseUrl: "https://api.example.test",
        apiKey: "configured",
        model: "custom-model",
        pricePerMTokenUsd: 12.5
      });
      expect(adapter.metadata.budgetPreflight?.pricePerMTokenUsd).toBe(12.5);
    } finally {
      if (previous === undefined) delete process.env.MARTIN_OPENAI_PRICE_PER_M_TOKEN_USD;
      else process.env.MARTIN_OPENAI_PRICE_PER_M_TOKEN_USD = previous;
    }
  });

  it("rejects invalid custom-model pricing authority from the runtime environment", () => {
    expect(() => resolveOpenAiCompatibleRuntimeConfig({
      MARTIN_OPENAI_PRICE_PER_M_TOKEN_USD: "not-a-price"
    })).toThrow(/INVALID_OPENAI_PRICE/u);
  });

  it.each([
    "https://user:secret@api.example.test",
    "https://api.example.test?api-version=1",
    "https://api.example.test#fragment"
  ])("rejects endpoint components that live request construction cannot preserve: %s", (baseUrl) => {
    expect(() => resolveOpenAiCompatibleRuntimeConfig({
      MARTIN_OPENAI_BASE_URL: baseUrl
    })).toThrow(/INVALID_OPENAI_BASE_URL/u);
    expect(() => createOpenAiCompatibleAdapter({
      baseUrl,
      model: "gpt-6.1-sol"
    })).toThrow(/INVALID_OPENAI_BASE_URL/u);
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

      const adapter = createOpenAiCompatibleAdapter({
        baseUrl: url,
        model: "test-model",
        pricePerMTokenUsd: 3
      });
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
