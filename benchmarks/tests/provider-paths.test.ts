import { describe, expect, it } from "vitest";

import {
  generateProviderPathReport,
  renderProviderPathReportMarkdown
} from "../src/index.js";

describe("Phase 13 provider-path validation", () => {
  it("classifies the current execution surfaces honestly", async () => {
    const report = await generateProviderPathReport();
    const surfaceIds = report.surfaces.map((surface) => surface.surfaceId);

    expect(surfaceIds).toEqual([
      "claude_cli",
      "codex_cli",
      "direct_http_contract",
      "routed_http_contract"
    ]);

    expect(report.summary.supportedForRc).toBe(2);
    expect(report.summary.unsupportedForRc).toBe(2);

    expect(report.surfaces.find((surface) => surface.surfaceId === "claude_cli")).toMatchObject({
      rcStatus: "supported_for_rc",
      accountingMode: "exact",
      transport: "cli"
    });

    expect(report.surfaces.find((surface) => surface.surfaceId === "codex_cli")).toMatchObject({
      rcStatus: "supported_for_rc",
      accountingMode: "estimated_only",
      transport: "cli"
    });

    expect(report.surfaces.find((surface) => surface.surfaceId === "direct_http_contract")).toMatchObject({
      rcStatus: "unsupported_for_rc",
      accountingMode: "unavailable",
      transport: "http"
    });

    expect(report.surfaces.find((surface) => surface.surfaceId === "routed_http_contract")).toMatchObject({
      rcStatus: "unsupported_for_rc",
      accountingMode: "unavailable",
      transport: "routed_http"
    });
  });

  it("renders a report suitable for RC review", async () => {
    const report = await generateProviderPathReport();
    const markdown = renderProviderPathReportMarkdown(report);

    expect(report.verdict).toBe("go");
    expect(markdown).toContain("# Martin Loop Phase 13 Provider Path Validation");
    expect(markdown).toContain("Claude CLI");
    expect(markdown).toContain("Codex CLI");
    expect(markdown).toContain("unsupported_for_rc");
  });
});
