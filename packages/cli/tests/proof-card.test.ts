import { describe, expect, it } from "vitest";

import {
  buildMartinProofCard,
  renderMartinProofCardMarkdown,
  renderMartinProofCardSvg,
  type MartinProofCardInput
} from "../src/proof-card.js";

const completeInput = (): MartinProofCardInput => ({
  loopId: "loop_viral_001",
  objective: "Stop Ralph from spending past the governed repair budget.",
  status: "halted",
  lifecycle: "verified_halt",
  verifierStatus: "passed",
  costSpend: "$18.42",
  budget: "$20.00",
  remainingBudget: "$1.58",
  overspendRatio: "0.92x",
  attempts: 3,
  rollbackStatus: "rollback-ready",
  verificationStepCount: 2,
  runMode: "mutating",
  runtime: "codex-cli / gpt-5-codex",
  timelineEvents: ["run.started", "attempt.started", "verification.completed", "budget.updated", "run.completed"],
  haltReason: "budget guard reached after verifier pass",
  evidenceBoundaryNotes: [
    "Artifacts live at C:\\workspace\\secret workspace\\runs\\loop_viral_001\\ledger.jsonl",
    "Verifier trace: /home/keesan/martin-loop/runs/loop_viral_001/verifier.txt"
  ],
  generatedAt: "2026-05-20T14:30:00.000Z"
});

describe("Martin proof cards", () => {
  it("renders complete evidence with the CLI proof receipt title and stop line", () => {
    const card = buildMartinProofCard(completeInput());
    const svg = renderMartinProofCardSvg(card);

    expect(renderMartinProofCardMarkdown(card)).toContain("Martin stopped Ralph here.");
    expect(svg).toContain("MARTIN LOOP :: PROOF RECEIPT");
    expect(svg).toContain("Martin stopped Ralph here.");
    expect(svg).toContain("$ martin runs verify --loop-id loop_viral_001");
  });

  it("renders an honest incomplete-evidence line when proof is missing", () => {
    const card = buildMartinProofCard({
      ...completeInput(),
      verifierStatus: "missing",
      budget: "",
      rollbackStatus: "not-recorded"
    });

    const markdown = renderMartinProofCardMarkdown(card);
    expect(markdown).toContain("Incomplete Martin proof: missing budget, rollback, or verifier evidence.");
    expect(markdown).not.toContain("Martin stopped Ralph here.");
  });

  it("fails closed when receipt integrity is unavailable", () => {
    const card = buildMartinProofCard({
      ...completeInput(),
      receiptIntegrityState: "unsigned"
    });

    const markdown = renderMartinProofCardMarkdown(card);
    expect(markdown).toContain("Receipt integrity unavailable: Martin proof is not yet trustworthy.");
    expect(markdown).not.toContain("Martin stopped Ralph here.");
  });

  it("does not leak absolute machine paths in Markdown or SVG", () => {
    const card = buildMartinProofCard(completeInput());
    const rendered = `${renderMartinProofCardMarkdown(card)}\n${renderMartinProofCardSvg(card)}`;

    expect(rendered).not.toContain("C:\\Users\\ExampleUser");
    expect(rendered).not.toContain("/home/keesan");
    expect(rendered).not.toContain("secret workspace");
    expect(rendered).toContain("[redacted-path]/ledger.jsonl");
    expect(rendered).toContain("[redacted-path]/verifier.txt");
  });

  it("keeps the proof card in the locked terminal visual language", () => {
    const svg = renderMartinProofCardSvg(buildMartinProofCard(completeInput()));

    expect(svg).toContain("METRICS");
    expect(svg).toContain("RUN CONTEXT");
    expect(svg).toContain("EVENT RAIL");
    expect(svg).toContain("BOUNDARY");
    expect(svg).not.toContain("rx=");
    expect(svg).not.toContain("linearGradient");
    expect(svg).not.toContain("radialGradient");
    expect(svg).not.toContain("Inter");
    expect(svg).not.toMatch(/#(?:0f172a|1d4ed8|2563eb|3178c6|3b82f6|60a5fa|93c5fd|bfdbfe|dbeafe)/iu);
  });

  it("renders unavailable fields as not recorded without inflating proof state", () => {
    const card = buildMartinProofCard({
      ...completeInput(),
      remainingBudget: undefined,
      overspendRatio: undefined,
      verificationStepCount: undefined,
      runMode: undefined,
      runtime: undefined,
      rollbackStatus: "not-recorded"
    });
    const svg = renderMartinProofCardSvg(card);

    expect(card.proofVerdict).toBe("EVIDENCE_BOUNDARY");
    expect(svg).toContain("not recorded");
    expect(svg).toContain("[EVIDENCE_BOUNDARY]");
  });

  it("uses restrained red and green semantics for boundary and verified states", () => {
    const verifiedSvg = renderMartinProofCardSvg(buildMartinProofCard(completeInput()));
    const boundarySvg = renderMartinProofCardSvg(
      buildMartinProofCard({
        ...completeInput(),
        rollbackStatus: "not-recorded"
      })
    );

    expect(verifiedSvg).toContain("#72b37e");
    expect(boundarySvg).toContain("#d35f5f");
  });

  it("renders deterministic Markdown and SVG for the same card", () => {
    const card = buildMartinProofCard(completeInput());

    expect(renderMartinProofCardMarkdown(card)).toBe(renderMartinProofCardMarkdown(card));
    expect(renderMartinProofCardSvg(card)).toBe(renderMartinProofCardSvg(card));
  });

  it("escapes Markdown and SVG text", () => {
    const card = buildMartinProofCard({
      ...completeInput(),
      objective: "Escape <script>alert('x')</script> & keep | pipes",
      haltReason: "Verifier said: <ok> & rollback | stable"
    });

    const markdown = renderMartinProofCardMarkdown(card);
    const svg = renderMartinProofCardSvg(card);

    expect(markdown).toContain("Escape &lt;script&gt;alert('x')&lt;/script&gt; &amp; keep \\| pipes");
    expect(markdown).toContain("Verifier said: &lt;ok&gt; &amp; rollback \\| stable");
    expect(svg).toContain("Verifier said: &lt;ok&gt; &amp; rollback...");
    expect(svg).not.toContain("<script>");
  });
});
