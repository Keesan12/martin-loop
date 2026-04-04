import { jsonError } from "./http";

type AuthScope =
  | {
      role: "admin";
      workspaceId?: undefined;
      userId: string;
    }
  | {
      role: "workspace";
      workspaceId: string;
      userId: string;
    };

export type AuthEnvironment = Record<string, string | undefined>;

export type AuthResult =
  | {
      ok: true;
      auth: AuthScope;
    }
  | {
      ok: false;
      response: Response;
    };

type AuthSnapshot = {
  isAuthenticated: boolean;
  userId: string | null;
  sessionId: string | null;
  sessionClaims?: Record<string, unknown> | undefined;
};

type AuthResolver = () => Promise<AuthSnapshot>;

let authResolver: AuthResolver = resolveClerkSnapshot;

export function setControlPlaneAuthResolverForTests(
  resolver: AuthResolver | null
): void {
  authResolver = resolver ?? resolveClerkSnapshot;
}

export async function requireControlPlaneAuth(
  _request: Request,
  options: {
    workspaceId?: string;
    requireAdmin?: boolean;
  } = {},
  env: AuthEnvironment = process.env
): Promise<AuthResult> {
  const configuration = resolveAuthConfiguration(env);
  const snapshot = await authResolver();

  if (!snapshot.isAuthenticated || !snapshot.userId) {
    return {
      ok: false,
      response: jsonError("authentication_required", "Clerk authentication is required.", {
        status: 401
      })
    };
  }

  const auth = resolveAuthScope(snapshot, configuration);

  if (options.requireAdmin && auth.role !== "admin") {
    return {
      ok: false,
      response: jsonError(
        "admin_scope_required",
        "This route requires an admin-scoped Martin session.",
        { status: 403 }
      )
    };
  }

  if (
    options.workspaceId &&
    auth.role !== "admin" &&
    auth.workspaceId !== options.workspaceId
  ) {
    return {
      ok: false,
      response: jsonError(
        "workspace_scope_mismatch",
        "The authenticated Martin session cannot act on the requested workspace.",
        { status: 403 }
      )
    };
  }

  return {
    ok: true,
    auth
  };
}

export function resolveAuthConfiguration(env: AuthEnvironment = process.env): {
  adminUserIds: Set<string>;
  defaultWorkspaceId: string;
} {
  const adminUserIds = new Set(
    (env.MARTIN_CONTROL_PLANE_ADMIN_USER_IDS ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean)
  );

  return {
    adminUserIds,
    defaultWorkspaceId: env.MARTIN_CONTROL_PLANE_DEFAULT_WORKSPACE_ID?.trim() || "ws_martin"
  };
}

async function resolveClerkSnapshot(): Promise<AuthSnapshot> {
  const { auth } = await import("@clerk/nextjs/server");
  const resolved = await auth();

  return {
    isAuthenticated: resolved.isAuthenticated,
    userId: resolved.userId,
    sessionId: resolved.sessionId,
    sessionClaims:
      resolved.sessionClaims && typeof resolved.sessionClaims === "object"
        ? (resolved.sessionClaims as Record<string, unknown>)
        : undefined
  };
}

function resolveAuthScope(
  snapshot: AuthSnapshot,
  configuration: ReturnType<typeof resolveAuthConfiguration>
): AuthScope {
  const userId = snapshot.userId as string;
  const sessionRole = readClaim(snapshot.sessionClaims, ["metadata", "martinRole"])
    ?? readClaim(snapshot.sessionClaims, ["publicMetadata", "martinRole"]);
  const sessionWorkspaceId =
    readClaim(snapshot.sessionClaims, ["metadata", "workspaceId"])
    ?? readClaim(snapshot.sessionClaims, ["publicMetadata", "workspaceId"])
    ?? configuration.defaultWorkspaceId;

  if (configuration.adminUserIds.has(userId) || sessionRole === "admin") {
    return {
      role: "admin",
      userId
    };
  }

  return {
    role: "workspace",
    workspaceId: sessionWorkspaceId,
    userId
  };
}

function readClaim(
  source: Record<string, unknown> | undefined,
  path: string[]
): string | undefined {
  let current: unknown = source;
  for (const segment of path) {
    if (!current || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return typeof current === "string" && current.length > 0 ? current : undefined;
}
