import { afterEach, describe, expect, it } from "vitest";

import { POST as postBilling } from "../app/api/billing/route.js";
import { POST as postPolicies } from "../app/api/policies/route.js";
import { POST as postTelemetry } from "../app/api/telemetry/route.js";
import { POST as postWorkspaces } from "../app/api/workspaces/route.js";
import {
  createUnavailableControlPlaneRepository,
  setControlPlaneRepositoryForTests
} from "../lib/server/control-plane-repository.js";
import {
  installAuthSession,
  installSeedRepository,
  resetControlPlaneTestState
} from "./control-plane-test-helpers.js";

afterEach(() => {
  resetControlPlaneTestState();
});

describe("control-plane API security defaults", () => {
  it("rejects unauthenticated requests before trusting caller-supplied workspace ids", async () => {
    installAuthSession({ authenticated: false });

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

    expect(response.status).toBe(401);

    const payload = (await response.json()) as {
      error: { code: string };
    };

    expect(payload.error.code).toBe("authentication_required");
  });

  it("rejects invalid telemetry payloads instead of accepting malformed loop data", async () => {
    await installSeedRepository();
    installAuthSession();

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
              loopId: "",
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

    expect(response.status).toBe(400);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");

    const payload = (await response.json()) as {
      error: { code: string };
    };

    expect(payload.error.code).toBe("invalid_telemetry_payload");
  });

  it("rejects telemetry payloads with malformed source or timestamp values", async () => {
    await installSeedRepository();
    installAuthSession();

    const response = await postTelemetry(
      new Request("http://localhost/api/telemetry", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          workspaceId: "ws_martin",
          source: "spreadsheet",
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
              lastSeenAt: "03/27/2026 15:00"
            }
          ]
        })
      })
    );

    expect(response.status).toBe(400);

    const payload = (await response.json()) as {
      error: { code: string };
    };

    expect(payload.error.code).toBe("invalid_telemetry_payload");
  });

  it("rejects workspace drafts with invalid billing emails", async () => {
    await installSeedRepository();
    installAuthSession({ role: "admin" });

    const response = await postWorkspaces(
      new Request("http://localhost/api/workspaces", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          id: "ws_finops",
          name: "FinOps Sandbox",
          primaryContact: "Avery Patel",
          billingEmail: "not-an-email"
        })
      })
    );

    expect(response.status).toBe(400);

    const payload = (await response.json()) as {
      error: { code: string };
    };

    expect(payload.error.code).toBe("invalid_workspace_payload");
  });

  it("rejects plan changes with non-positive seat requests", async () => {
    await installSeedRepository();
    installAuthSession({ role: "workspace", workspaceId: "ws_martin" });

    const response = await postBilling(
      new Request("http://localhost/api/billing", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          workspaceId: "ws_martin",
          requestedPlan: "Enterprise Control Plane",
          seatsRequested: 0,
          billingEmail: "finance@martinloop.dev"
        })
      })
    );

    expect(response.status).toBe(400);

    const payload = (await response.json()) as {
      error: { code: string };
    };

    expect(payload.error.code).toBe("invalid_billing_request");
  });

  it("rejects policy updates without a bounded policies array", async () => {
    await installSeedRepository();
    installAuthSession({ role: "workspace", workspaceId: "ws_martin" });

    const response = await postPolicies(
      new Request("http://localhost/api/policies", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          workspaceId: "ws_martin",
          policies: []
        })
      })
    );

    expect(response.status).toBe(400);

    const payload = (await response.json()) as {
      error: { code: string };
    };

    expect(payload.error.code).toBe("invalid_policy_payload");
  });

  it("rejects requests whose authenticated workspace does not match the payload workspace", async () => {
    await installSeedRepository();
    installAuthSession({ role: "workspace", workspaceId: "ws_martin" });

    const response = await postBilling(
      new Request("http://localhost/api/billing", {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        body: JSON.stringify({
          workspaceId: "ws_other",
          requestedPlan: "Enterprise Control Plane",
          seatsRequested: 32,
          billingEmail: "finance@martinloop.dev"
        })
      })
    );

    expect(response.status).toBe(403);

    const payload = (await response.json()) as {
      error: { code: string };
    };

    expect(payload.error.code).toBe("workspace_scope_mismatch");
  });

  it("requires admin scope for workspace management endpoints", async () => {
    await installSeedRepository();
    installAuthSession({ role: "workspace", workspaceId: "ws_martin" });

    const response = await postWorkspaces(
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

    expect(response.status).toBe(403);

    const payload = (await response.json()) as {
      error: { code: string };
    };

    expect(payload.error.code).toBe("admin_scope_required");
  });

  it("fails closed when Supabase-backed write routes are unavailable", async () => {
    setControlPlaneRepositoryForTests(createUnavailableControlPlaneRepository());
    installAuthSession({ role: "admin" });

    const response = await postWorkspaces(
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

    expect(response.status).toBe(503);

    const payload = (await response.json()) as {
      error: { code: string };
    };

    expect(payload.error.code).toBe("supabase_not_configured");
  });
});
