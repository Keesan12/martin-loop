import { afterEach, describe, expect, it } from "vitest";

import {
  getBillingPageData,
  getEconomicsPageData,
  getGovernancePageData,
  getNavigationItems,
  getOperationsPageData,
  getOverviewPageData,
  getSettingsPageData
} from "../lib/queries/control-plane-queries.js";
import * as controlPlaneQueries from "../lib/queries/control-plane-queries.js";
import { buildExecutiveOverviewViewModel } from "../lib/view-models/executive-overview.js";
import { buildEconomicsViewModel } from "../lib/view-models/operator-economics.js";
import {
  createInMemoryControlPlaneRepository,
  setControlPlaneRepositoryForTests
} from "../lib/server/control-plane-repository.js";
import {
  installSeedRepository,
  resetControlPlaneTestState
} from "./control-plane-test-helpers.js";

afterEach(() => {
  resetControlPlaneTestState();
});

describe("control-plane IA", () => {
  it("routes overview composition through the executive-overview view-model", async () => {
    await installSeedRepository();

    expect(await getOverviewPageData()).toEqual(await buildExecutiveOverviewViewModel());
  });

  it("uses the hosted executive navigation order", () => {
    expect(getNavigationItems().map((item) => item.label)).toEqual([
      "Overview",
      "Cost Dashboard",
      "Operations",
      "Economics",
      "Governance",
      "Billing",
      "Admin"
    ]);
  });

  it("returns overview data with the required top-of-page executive sections", async () => {
    await installSeedRepository();

    const overview = await getOverviewPageData();

    expect(overview.kpiBand.map((metric) => metric.label)).toEqual([
      "Actual AI Spend",
      "Month-End Forecast",
      "Modeled Avoided Spend",
      "Verified Solve Rate"
    ]);
    expect(overview.executiveContext.workspaceLabel).toBe("Martin Loop");
    expect(overview.trustStrip.length).toBeGreaterThan(0);
    expect(overview.exceptions.length).toBeGreaterThan(0);
    expect(overview.primaryTrend.points.length).toBeGreaterThan(0);
  });

  it("supports explicit provenance labels for actual, estimated, modeled, freshness, source, and policy context", async () => {
    await installSeedRepository();

    const overview = await getOverviewPageData();
    const supportedLabels = new Set(
      [
        ...overview.executiveContext.labels,
        ...overview.primaryTrend.labels,
        ...overview.kpiBand.flatMap((item) => item.labels),
        ...overview.trustStrip.flatMap((item) => item.labels),
        ...overview.exceptions.flatMap((item) => item.labels)
      ].map((entry) => entry.label)
    );

    for (const label of [
      "Actual",
      "Estimated",
      "Modeled",
      "Freshness",
      "Source",
      "Methodology available",
      "Policy provenance"
    ]) {
      expect(supportedLabels.has(label)).toBe(true);
    }
  });

  it("shows honest empty states when no runs have been ingested yet", async () => {
    setControlPlaneRepositoryForTests(createInMemoryControlPlaneRepository());

    const overview = await getOverviewPageData();
    const billing = await getBillingPageData();
    const settings = await getSettingsPageData();

    expect(overview.executiveContext.reportingWindow).toBe("No runs yet");
    expect(overview.exceptions[0]?.title).toBe("No runs yet");
    expect(billing.account).toBeNull();
    expect(settings.workspace).toBeNull();
  });
});

describe("supporting page queries", () => {
  it("returns operations/economics/governance detail blocks for the live executive IA", async () => {
    await installSeedRepository();

    const operations = await getOperationsPageData();
    const economics = await getEconomicsPageData();
    const governance = await getGovernancePageData();

    expect(operations.focusAreas.length).toBeGreaterThan(0);
    expect(economics.kpiBand.some((item) => item.label === "Modeled Avoided Spend")).toBe(true);
    expect(governance.policyRows[0]?.labels.some((entry) => entry.label === "Policy provenance")).toBe(true);
  });

  it("routes economics composition through the dedicated economics view-model", async () => {
    await installSeedRepository();

    expect(await getEconomicsPageData()).toEqual(await buildEconomicsViewModel());
  });

  it("keeps billing and admin workspaces queryable from the executive shell", async () => {
    await installSeedRepository();

    const billing = await getBillingPageData();
    const admin = await getSettingsPageData();

    expect(billing.account?.planName).toContain("Growth");
    expect(billing.seatMix.reduce((total, item) => total + item.count, 0)).toBe(10);
    expect(admin.roles.length).toBeGreaterThan(0);
  });

  it("surfaces patch, grounding, leash, budget variance, and stop-reason truth in the live read model", async () => {
    await installSeedRepository();

    const operations = await getOperationsPageData();
    const overview = await getOverviewPageData();
    const labels = new Set(
      [
        ...operations.focusAreas.flatMap((item) => item.labels),
        ...overview.exceptions.flatMap((item) => item.labels),
        ...operations.trustStrip.flatMap((item) => item.labels),
        ...operations.executiveContext.labels
      ].map((entry) => entry.label)
    );

    for (const label of [
      "Patch decision",
      "Grounding evidence",
      "Leash surface",
      "Budget variance",
      "Accounting mode",
      "Stop reason"
    ]) {
      expect(labels.has(label)).toBe(true);
    }
  });
});

describe("legacy hosted IA removal", () => {
  it("removes legacy hosted route files and query exports", async () => {
    const { existsSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    const testDir = dirname(fileURLToPath(import.meta.url));
    const legacyRoutes = ["loops", "savings", "policies", "integrations"];

    for (const routeName of legacyRoutes) {
      expect(existsSync(resolve(testDir, "../app", routeName, "page.tsx"))).toBe(false);
    }

    const legacyExports = [
      "getLoopsPageData",
      "getSavingsPageData",
      "getPoliciesPageData",
      "getIntegrationsPageData"
    ] as const;

    for (const exportName of legacyExports) {
      expect(Object.prototype.hasOwnProperty.call(controlPlaneQueries, exportName)).toBe(false);
      expect((controlPlaneQueries as Record<string, unknown>)[exportName]).toBeUndefined();
    }
  });
});
