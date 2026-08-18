import type { LoopBudget, ReceiptScope } from "@martin/contracts";

import { renderTable } from "./table.js";
import { horizontalRule, terminalWidth, truncateVisible } from "./text.js";
import {
  bold,
  paint,
  type MartinTone,
  type RenderEnvironment,
} from "./theme.js";

export type PlanStageState = "READY" | "BLOCKED" | "NEXT" | "CONDITIONAL";

export interface GovernedPlanStage {
  label: string;
  state: PlanStageState;
  gate: string;
  purpose: string;
}

export interface GovernedRunPlanView {
  ready: boolean;
  task: string;
  engine: string;
  mode: "live" | "proof";
  budget: LoopBudget;
  verifier: string[];
  receiptScope: ReceiptScope;
  policyProfile: string;
  blockingIssues: string[];
  warnings: string[];
  stages: GovernedPlanStage[];
}

function stageTone(state: PlanStageState): MartinTone {
  switch (state) {
    case "READY":
      return "success";
    case "BLOCKED":
      return "danger";
    case "NEXT":
      return "info";
    case "CONDITIONAL":
      return "warning";
  }
}

export function buildGovernedPlanStages(
  input: Pick<
    GovernedRunPlanView,
    "ready" | "engine" | "verifier" | "blockingIssues"
  >,
): GovernedPlanStage[] {
  const blocked = !input.ready || input.blockingIssues.length > 0;
  return [
    {
      label: "Contract & scope",
      state: blocked ? "BLOCKED" : "READY",
      gate: "request + paths",
      purpose: "Bind the task to its governed workspace",
    },
    {
      label: "Budget & policy",
      state: blocked ? "BLOCKED" : "READY",
      gate: "hard cap + policy",
      purpose: "Arm execution limits before work starts",
    },
    {
      label: "Agent execution",
      state: blocked ? "BLOCKED" : "NEXT",
      gate: input.engine,
      purpose: "Run the selected coding agent",
    },
    {
      label: "Verification",
      state: input.verifier.length > 0 && !blocked ? "NEXT" : "BLOCKED",
      gate: input.verifier.length > 0 ? input.verifier.join(", ") : "no verifier",
      purpose: "Run configured completion checks",
    },
    {
      label: "Recovery",
      state: "CONDITIONAL",
      gate: "stop / fail",
      purpose: "Preserve rollback and recovery evidence",
    },
    {
      label: "Proof",
      state: blocked ? "BLOCKED" : "NEXT",
      gate: "receipt",
      purpose: "Produce the final governed record",
    },
  ];
}

function bounded(line: string, width: number): string {
  return truncateVisible(line, width);
}

export function renderGovernedRunPlan(
  input: GovernedRunPlanView,
  options: { width?: number; environment?: RenderEnvironment } = {},
): string {
  const environment = options.environment ?? {};
  const width = terminalWidth(options.width);
  const rows = input.stages.map((stage) => ({
    ...stage,
    renderedState: paint(stage.state, stageTone(stage.state), environment),
  }));

  const lines = [
    horizontalRule(width, "━"),
    bounded(
      bold("MARTINLOOP", environment) +
        " ▸ " +
        paint(
          "GOVERNED RUN PLAN",
          input.ready ? "success" : "danger",
          environment,
        ),
      width,
    ),
    horizontalRule(width, "━"),
    "",
    bounded(paint("Task".padEnd(18), "info", environment) + input.task, width),
    bounded(paint("Engine".padEnd(18), "info", environment) + input.engine, width),
    bounded(paint("Mode".padEnd(18), "info", environment) + input.mode, width),
    "",
    renderTable(
      rows,
      [
        { header: "STAGE", value: (row) => row.label, minWidth: 18, maxWidth: 24 },
        {
          header: "STATUS",
          value: (row) => row.renderedState,
          minWidth: 12,
          maxWidth: 14,
        },
        { header: "GATE", value: (row) => row.gate, minWidth: 18, maxWidth: 36 },
        { header: "PURPOSE", value: (row) => row.purpose, minWidth: 24 },
      ],
      width,
    ),
    "",
    bounded(
      bold("Budget cap", environment) +
        "  " +
        paint("$" + input.budget.maxUsd.toFixed(2), "success", environment),
      width,
    ),
    bounded(
      bold("Soft limit", environment) +
        "  $" +
        input.budget.softLimitUsd.toFixed(2),
      width,
    ),
    bounded(
      bold("Attempts", environment) + "    " + input.budget.maxIterations,
      width,
    ),
    bounded(
      bold("Verifier", environment) +
        "    " +
        (input.verifier.join(", ") || "NOT CONFIGURED"),
      width,
    ),
    bounded(
      bold("Policy", environment) + "      " + input.policyProfile,
      width,
    ),
  ];

  if (input.blockingIssues.length > 0) {
    lines.push(
      "",
      bold("BLOCKING", environment),
      ...input.blockingIssues.map((issue) =>
        bounded("  " + paint("✗", "danger", environment) + " " + issue, width),
      ),
    );
  }
  if (input.warnings.length > 0) {
    lines.push(
      "",
      bold("WARNINGS", environment),
      ...input.warnings.map((warning) =>
        bounded("  " + paint("!", "warning", environment) + " " + warning, width),
      ),
    );
  }

  lines.push(
    "",
    input.ready
      ? paint("✓ READY TO EXECUTE", "success", environment)
      : paint("✗ PREFLIGHT BLOCKED", "danger", environment),
    horizontalRule(width, "━"),
  );
  return lines.map((line) => bounded(line, width)).join("\n");
}
