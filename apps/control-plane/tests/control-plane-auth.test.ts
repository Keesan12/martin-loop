import { afterEach, describe, expect, it } from "vitest";

import {
  requireControlPlaneAuth,
  resolveAuthConfiguration
} from "../lib/server/auth.js";
import {
  installAuthSession,
  resetControlPlaneTestState
} from "./control-plane-test-helpers.js";

afterEach(() => {
  resetControlPlaneTestState();
});

describe("control-plane auth configuration", () => {
  it("reads admin ids and default workspace from environment", () => {
    const configuration = resolveAuthConfiguration({
      MARTIN_CONTROL_PLANE_ADMIN_USER_IDS: "user_admin,user_other",
      MARTIN_CONTROL_PLANE_DEFAULT_WORKSPACE_ID: "ws_finops"
    });

    expect(configuration.adminUserIds.has("user_admin")).toBe(true);
    expect(configuration.adminUserIds.has("user_other")).toBe(true);
    expect(configuration.defaultWorkspaceId).toBe("ws_finops");
  });

  it("falls back to the Martin workspace default when no workspace claim is present", async () => {
    installAuthSession({ workspaceId: "ws_martin" });

    const result = await requireControlPlaneAuth(new Request("http://localhost/api/billing"));

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.auth).toEqual({
        role: "workspace",
        userId: "user_123",
        workspaceId: "ws_martin"
      });
    }
  });
});

describe("requireControlPlaneAuth", () => {
  it("rejects unauthenticated requests", async () => {
    installAuthSession({ authenticated: false });

    const result = await requireControlPlaneAuth(new Request("http://localhost/api/billing"));

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.response.status).toBe(401);
      const payload = (await result.response.json()) as { error: { code: string } };
      expect(payload.error.code).toBe("authentication_required");
    }
  });

  it("grants admin scope from configured admin user ids", async () => {
    installAuthSession({
      userId: "user_admin",
      role: "workspace",
      workspaceId: "ws_other"
    });

    const result = await requireControlPlaneAuth(
      new Request("http://localhost/api/workspaces"),
      { requireAdmin: true },
      {
        MARTIN_CONTROL_PLANE_ADMIN_USER_IDS: "user_admin"
      }
    );

    expect(result.ok).toBe(true);

    if (result.ok) {
      expect(result.auth).toEqual({
        role: "admin",
        userId: "user_admin"
      });
    }
  });

  it("rejects workspace-scoped sessions that target another workspace", async () => {
    installAuthSession({
      role: "workspace",
      workspaceId: "ws_martin"
    });

    const result = await requireControlPlaneAuth(
      new Request("http://localhost/api/billing"),
      { workspaceId: "ws_other" }
    );

    expect(result.ok).toBe(false);

    if (!result.ok) {
      expect(result.response.status).toBe(403);
      const payload = (await result.response.json()) as { error: { code: string } };
      expect(payload.error.code).toBe("workspace_scope_mismatch");
    }
  });
});
