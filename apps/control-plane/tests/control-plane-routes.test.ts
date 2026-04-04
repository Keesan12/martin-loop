import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import OverviewPage from "../app/page.js";
import OperationsPage from "../app/operations/page.js";
import EconomicsPage from "../app/economics/page.js";
import GovernancePage from "../app/governance/page.js";
import BillingPage from "../app/billing/page.js";
import SettingsPage from "../app/settings/page.js";
import { POST as postBilling, GET as getBilling } from "../app/api/billing/route.js";
import { POST as postPolicies, GET as getPolicies } from "../app/api/policies/route.js";
import { GET as getRuns } from "../app/api/runs/route.js";
import { POST as postTelemetry } from "../app/api/telemetry/route.js";
import { POST as postWorkspaces, GET as getWorkspaces } from "../app/api/workspaces/route.js";
import {
  installAuthSession,
  installSeedRepository,
  resetControlPlaneTestState
} from "./control-plane-test-helpers.js";

const testDir = dirname(fileURLToPath(import.meta.url));

afterEach(() => {
  resetControlPlaneTestState();
});

describe("executive route rendering", () => {
  it("renders the required overview-above-fold executive sections", async () => {
    // OverviewPage is an async server component — await before rendering.
    const html = renderToStaticMarkup(await OverviewPage());

    for (const section of [
      "Executive context",
      "Trust strip",
      "Exceptions"
    ]) {
      expect(html).toContain(section);
    }
  });

  it("renders the hosted executive IA routes and exact shell nav labels", async () => {
    await installSeedRepository();

    const routeHtml = (
      await Promise.all([
        OperationsPage(),
        EconomicsPage(),
        GovernancePage(),
        BillingPage(),
        SettingsPage()
      ])
    )
      .map((page) => renderToStaticMarkup(page))
      .join(" ");

    for (const label of ["Overview", "Operations", "Economics", "Governance", "Billing", "Admin"]) {
      expect(routeHtml).toContain(label);
    }

    expect(routeHtml).not.toContain('href="/loops"');
    expect(routeHtml).not.toContain('href="/savings"');
    expect(routeHtml).not.toContain('href="/policies"');
    expect(routeHtml).not.toContain('href="/integrations"');
    expect(routeHtml).not.toContain(">Settings<");
  });

  it("does not ship the retired legacy route pages", () => {
    for (const routeName of ["loops", "savings", "policies", "integrations"]) {
      expect(existsSync(resolve(testDir, "../app", routeName, "page.tsx"))).toBe(false);
    }
  });
});

describe("telemetry route", () => {
  it("accepts a valid telemetry ingest payload and returns a normalized receipt", async () => {
    await installSeedRepository();
    installAuthSession({ role: "workspace", workspaceId: "ws_martin" });

    const response = await postTelemetry(
      new Request("http://localhost/api/telemetry", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          workspaceId: "ws_martin",
          source: "sdk",
          loops: [
            {
              loopId: "loop_ingest",
              name: "Treasury variance monitor",
              project: "treasury",
              ownerTeam: "Finance Systems",
              agentCount: 2,
              status: "healthy",
              actualCostUsd: 22,
              avoidedCostUsd: 49,
              tokensProcessed: 23000,
              lastSeenAt: "2026-03-27T15:00:00.000Z"
            }
          ]
        })
      })
    );

    expect(response.status).toBe(202);

    const payload = (await response.json()) as {
      accepted: boolean;
      summary: { loops: number; totalActualUsd: number; runsIngested: number };
    };

    expect(payload.accepted).toBe(true);
    expect(payload.summary.loops).toBe(1);
    expect(payload.summary.totalActualUsd).toBe(22);
    expect(payload.summary.runsIngested).toBeGreaterThanOrEqual(0);
  });
});

describe("workspace route", () => {
  it("returns seeded workspaces and acknowledges a draft workspace request", async () => {
    const repository = await installSeedRepository();
    installAuthSession({ role: "admin" });

    const listResponse = await getWorkspaces(
      new Request("http://localhost/api/workspaces")
    );
    const listPayload = (await listResponse.json()) as { workspaces: Array<{ id: string }> };

    expect(listResponse.status).toBe(200);
    expect(listPayload.workspaces[0]?.id).toBe("ws_martin");

    const createResponse = await postWorkspaces(
      new Request("http://localhost/api/workspaces", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          id: "ws_finops",
          name: "FinOps Sandbox",
          primaryContact: "Avery Patel",
          billingEmail: "finops@example.com"
        })
      })
    );

    const createPayload = (await createResponse.json()) as {
      accepted: boolean;
      workspace: { name: string; plan: string };
    };

    expect(createResponse.status).toBe(201);
    expect(createPayload.workspace.name).toBe("FinOps Sandbox");
    expect(createPayload.workspace.plan).toBe("Growth");

    const allWorkspaces = await repository.listWorkspaces();
    expect(allWorkspaces.some((workspace) => workspace.id === "ws_finops")).toBe(true);
  });
});

describe("runs route", () => {
  it("returns artifact-backed run summaries with attempt-level truth details", async () => {
    await installSeedRepository();
    installAuthSession({ role: "workspace", workspaceId: "ws_martin" });

    const response = await getRuns(new Request("http://localhost/api/runs"));
    const payload = (await response.json()) as {
      runs: Array<{
        runId: string;
        latestPatchDecision: string | null;
        groundingViolationCount: number;
        blockedSafetyViolationCount: number;
        budgetVarianceUsd: number;
        attempts: Array<{
          attemptIndex: number;
          patchDecision: string | null;
          groundingViolationCount: number;
          safetySurface: string | null;
          budgetProvenance: string | null;
        }>;
      }>;
    };

    expect(response.status).toBe(200);
    expect(payload.runs[0]?.runId).toBe("run_001");
    expect(payload.runs[0]?.latestPatchDecision).toBe("KEEP");
    expect(payload.runs[0]?.groundingViolationCount).toBe(1);
    expect(payload.runs[0]?.blockedSafetyViolationCount).toBe(1);
    expect(payload.runs[0]?.budgetVarianceUsd).toBe(-0.4);
    expect(payload.runs[0]?.attempts[0]).toMatchObject({
      attemptIndex: 1,
      patchDecision: "DISCARD",
      groundingViolationCount: 1,
      safetySurface: "filesystem",
      budgetProvenance: "actual"
    });
    expect(payload.runs[0]?.attempts[1]).toMatchObject({
      attemptIndex: 2,
      patchDecision: "KEEP",
      groundingViolationCount: 0,
      budgetProvenance: "actual"
    });
  });
});

describe("policy route", () => {
  it("returns policy coverage and echoes a policy update request", async () => {
    const repository = await installSeedRepository();
    installAuthSession({ role: "workspace", workspaceId: "ws_martin" });

    const listResponse = await getPolicies(
      new Request("http://localhost/api/policies")
    );
    const listPayload = (await listResponse.json()) as { policies: Array<{ id: string }> };

    expect(listPayload.policies.length).toBeGreaterThan(0);

    const updateResponse = await postPolicies(
      new Request("http://localhost/api/policies", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          workspaceId: "ws_martin",
          policies: [
            {
              id: "policy_new",
              name: "Investor memo guardrail",
              scope: "Board reporting",
              owner: "Finance Ops",
              status: "Draft",
              monthlyBudgetUsd: 3500,
              maxIterations: 6,
              fallbackModel: "gpt-4o-mini",
              alertThresholdPct: 72,
              autoStopAfterMinutes: 18,
              description: "Escalate to human review when confidence falls below threshold."
            }
          ]
        })
      })
    );

    const updatePayload = (await updateResponse.json()) as {
      accepted: boolean;
      updatedCount: number;
    };

    expect(updateResponse.status).toBe(202);
    expect(updatePayload.accepted).toBe(true);
    expect(updatePayload.updatedCount).toBe(1);

    const storedPolicies = await repository.listPolicies("ws_martin");
    expect(storedPolicies.some((policy) => policy.id === "policy_new")).toBe(true);
  });
});

describe("billing route", () => {
  it("returns the billing summary and previews a plan-change request", async () => {
    await installSeedRepository();
    installAuthSession({ role: "workspace", workspaceId: "ws_martin" });

    const getResponse = await getBilling(
      new Request("http://localhost/api/billing")
    );
    const getPayload = (await getResponse.json()) as {
      account: { planName: string };
    };

    expect(getResponse.status).toBe(200);
    expect(getPayload.account.planName).toContain("Growth");

    const postResponse = await postBilling(
      new Request("http://localhost/api/billing", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          workspaceId: "ws_martin",
          requestedPlan: "Enterprise Control Plane",
          seatsRequested: 32,
          billingEmail: "finance@martinloop.dev"
        })
      })
    );

    const postPayload = (await postResponse.json()) as {
      accepted: boolean;
      preview: { requestedPlan: string; seatsRequested: number };
    };

    expect(postResponse.status).toBe(202);
    expect(postPayload.preview.requestedPlan).toBe("Enterprise Control Plane");
    expect(postPayload.preview.seatsRequested).toBe(32);
  });
});
