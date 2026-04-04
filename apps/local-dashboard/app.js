let data = null;

async function loadData() {
  try {
    const res = await fetch("/api/runs");
    if (res.ok) {
      data = await res.json();
    }
  } catch {
    data = createOfflineData();
  }

  if (!data) {
    data = createOfflineData();
  }

  renderAll();
}

function createOfflineData() {
  return {
    seedLabel: "No runs yet",
    currentRun: {
      title: "No runs yet",
      objective: "Run Martin once to populate the local dashboard with real data.",
      state: "idle",
      attempt: 0,
      elapsed: "00:00:00",
      model: "—",
      adapter: "—",
      policyProfile: "—",
      repo: "—",
      startedAt: "—"
    },
    budget: {
      spentUsd: 0,
      hardLimitUsd: 0,
      softLimitUsd: 0,
      tokensUsed: 0,
      maxTokens: 0,
      iterationsUsed: 0,
      maxIterations: 0,
      projectedExitUsd: 0,
      checkpoints: [],
      projectedExitNote: "No persisted run data available yet."
    },
    attemptState: {
      phase: "idle",
      summary: "No runs yet.",
      activeStep: "Await first run",
      previousError: "None",
      interventionSelected: "None"
    },
    verifier: {
      summary: "No verifier activity yet.",
      lastGate: { label: "No runs yet", status: "pending", timestamp: "", detail: "" },
      nextGate: { label: "Start a run", status: "queued" },
      trend: []
    },
    effectivePolicy: {
      policyProfile: "Not loaded",
      destructiveActionPolicy: "approval",
      approvalRequired: true,
      telemetryDestination: "local-only",
      provenance: []
    },
    replayResume: {
      exitReason: "No runs yet.",
      nextAction: "Run Martin once to populate this dashboard.",
      replayCommand: "martin run --objective \"Describe your task\" --max-iterations 3"
    },
    timeline: [],
    interventions: [],
    artifacts: [],
    benchmarkLab: {
      seedLabel: "No runs yet",
      summary: [],
      rows: []
    }
  };
}

function toneClass(status) {
  if (status === "passed" || status === "positive" || status === "ready" || status === "applied") {
    return "positive";
  }
  if (status === "failed" || status === "warning") {
    return "warning";
  }
  if (status === "danger") {
    return "danger";
  }
  return "neutral";
}

function renderHeader() {
  const run = data.currentRun;
  document.querySelector("#run-header").innerHTML = `
    <div class="card-head">
      <p class="eyebrow">Current Run</p>
      <h1>${run.title}</h1>
      <p class="subtle">${run.objective}</p>
    </div>
    <div class="run-meta-grid">
      <div class="meta-chip"><span class="meta-label">State</span><strong>${run.state}</strong></div>
      <div class="meta-chip"><span class="meta-label">Attempt</span><strong>${run.attempt}</strong></div>
      <div class="meta-chip"><span class="meta-label">Elapsed</span><strong>${run.elapsed}</strong></div>
      <div class="meta-chip"><span class="meta-label">Model</span><strong>${run.model}</strong></div>
      <div class="meta-chip"><span class="meta-label">Adapter</span><strong>${run.adapter}</strong></div>
      <div class="meta-chip"><span class="meta-label">Policy</span><strong>${run.policyProfile}</strong></div>
      <div class="meta-chip"><span class="meta-label">Repo</span><strong>${run.repo}</strong></div>
      <div class="meta-chip"><span class="meta-label">Started</span><strong>${run.startedAt}</strong></div>
    </div>
    <div class="seed-line">
      <span class="pill neutral">${data.seedLabel}</span>
    </div>
  `;
}

function renderBudgetStrip() {
  const budget = data.budget;
  document.querySelector("#budget-strip").innerHTML = `
    <div class="strip-item">
      <span class="metric-label">Spend</span>
      <strong>$${budget.spentUsd.toFixed(2)} / $${budget.hardLimitUsd.toFixed(2)}</strong>
    </div>
    <div class="strip-item">
      <span class="metric-label">Soft limit</span>
      <strong>$${budget.softLimitUsd.toFixed(2)}</strong>
    </div>
    <div class="strip-item">
      <span class="metric-label">Tokens</span>
      <strong>${budget.tokensUsed.toLocaleString()} / ${budget.maxTokens.toLocaleString()}</strong>
    </div>
    <div class="strip-item">
      <span class="metric-label">Iterations</span>
      <strong>${budget.iterationsUsed} / ${budget.maxIterations}</strong>
    </div>
    <div class="strip-item">
      <span class="metric-label">Projected exit</span>
      <strong>$${budget.projectedExitUsd.toFixed(2)}</strong>
    </div>
  `;
}

function renderAttemptState() {
  const attemptState = data.attemptState;
  document.querySelector("#attempt-state").innerHTML = `
    <div class="card-head">
      <h2>Attempt State</h2>
      <p>${attemptState.summary}</p>
    </div>
    <div class="stack-list">
      <div class="row compact"><span>Phase</span><strong>${attemptState.phase}</strong></div>
      <div class="row compact"><span>Active step</span><strong>${attemptState.activeStep}</strong></div>
      <div class="row compact"><span>Previous error</span><strong>${attemptState.previousError}</strong></div>
      <div class="row compact"><span>Intervention</span><strong>${attemptState.interventionSelected}</strong></div>
    </div>
  `;
}

function renderVerifierState() {
  const verifier = data.verifier;
  document.querySelector("#verifier-state").innerHTML = `
    <div class="card-head">
      <h2>Verifier State</h2>
      <p>${verifier.summary}</p>
    </div>
    <div class="row compact">
      <span>Last gate</span>
      <span class="pill ${toneClass(verifier.lastGate.status)}">${verifier.lastGate.label}: ${verifier.lastGate.status}</span>
    </div>
    <div class="row compact"><span>Timestamp</span><strong>${verifier.lastGate.timestamp}</strong></div>
    <div class="row compact"><span>Next gate</span><strong>${verifier.nextGate.label} (${verifier.nextGate.status})</strong></div>
  `;
}

function renderEffectivePolicy() {
  const policy = data.effectivePolicy;
  document.querySelector("#effective-policy").innerHTML = `
    <div class="card-head">
      <h2>Effective Policy</h2>
      <p>Policy and provenance that governed this run.</p>
    </div>
    <div class="stack-list">
      <div class="row compact"><span>Profile</span><strong>${policy.policyProfile}</strong></div>
      <div class="row compact"><span>Destructive actions</span><strong>${policy.destructiveActionPolicy}</strong></div>
      <div class="row compact"><span>Approval required</span><strong>${policy.approvalRequired ? "Yes" : "No"}</strong></div>
      <div class="row compact"><span>Telemetry destination</span><strong>${policy.telemetryDestination}</strong></div>
    </div>
    <div class="subsection">
      <p class="metric-label">Provenance</p>
      ${policy.provenance
        .map(
          (item) => `
            <div class="row compact">
              <span>${item.field}</span>
              <strong>${item.value} (${item.source})</strong>
            </div>
          `
        )
        .join("")}
    </div>
  `;
}

function renderExitOrientation() {
  const replay = data.replayResume;
  document.querySelector("#exit-orientation").innerHTML = `
    <div class="card-head">
      <h2>Exit / Replay Orientation</h2>
      <p>What happens if this run exits and how to continue safely.</p>
    </div>
    <div class="stack-list">
      <div class="row compact"><span>Exit reason</span><strong>${replay.exitReason}</strong></div>
      <div class="row compact"><span>Next action</span><strong>${replay.nextAction}</strong></div>
    </div>
  `;
}

function renderTimeline() {
  document.querySelector("#timeline-list").innerHTML = data.timeline
    .map(
      (item) => `
        <div class="row">
          <div>
            <p><strong>${item.attempt}</strong></p>
            <p class="subtle">${item.event}</p>
          </div>
          <div class="timeline-meta">
            <span class="pill ${toneClass(item.tone)}">${item.tone}</span>
            <span class="subtle">${item.time}</span>
          </div>
        </div>
      `
    )
    .join("");
}

function renderBudgetPanel() {
  const budget = data.budget;
  const spendPct = Math.min(Math.round((budget.spentUsd / budget.hardLimitUsd) * 100), 100);
  const tokenPct = Math.min(Math.round((budget.tokensUsed / budget.maxTokens) * 100), 100);

  document.querySelector("#budget-panel").innerHTML = `
    <p class="subtle">${budget.projectedExitNote}</p>
    <div class="meter">
      <div class="meter-head"><span>USD burn</span><span>${spendPct}%</span></div>
      <div class="track"><div class="fill" style="width:${spendPct}%"></div></div>
    </div>
    <div class="meter">
      <div class="meter-head"><span>Token burn</span><span>${tokenPct}%</span></div>
      <div class="track"><div class="fill" style="width:${tokenPct}%"></div></div>
    </div>
    ${budget.checkpoints
      .map(
        (item) => `
          <div class="row compact">
            <span>${item.label}</span>
            <strong>${item.value}</strong>
          </div>
        `
      )
      .join("")}
  `;
}

function renderVerifierPanel() {
  const verifier = data.verifier;
  document.querySelector("#verifier-panel").innerHTML = verifier.trend
    .map(
      (item) => `
        <div class="row">
          <div>
            <p><strong>${item.label}</strong></p>
            <p class="subtle">${item.reason}</p>
          </div>
          <span class="pill ${toneClass(item.status)}">${item.status}</span>
        </div>
      `
    )
    .join("");
}

function renderInterventions() {
  document.querySelector("#interventions-list").innerHTML = data.interventions
    .map(
      (item) => `
        <div class="row">
          <div>
            <p><strong>${item.title}</strong></p>
            <p class="subtle">${item.detail}</p>
          </div>
          <span class="pill ${toneClass(item.status)}">${item.status}</span>
        </div>
      `
    )
    .join("");
}

function renderArtifacts() {
  document.querySelector("#artifacts-list").innerHTML = data.artifacts
    .map(
      (item) => `
        <div class="row">
          <div>
            <p><strong>${item.name}</strong></p>
            <p class="subtle">${item.type} • ${item.detail}</p>
          </div>
          <span class="pill ${toneClass(item.status)}">${item.status}</span>
        </div>
      `
    )
    .join("");
}

function renderReplayPanel() {
  const replay = data.replayResume;
  document.querySelector("#replay-panel").innerHTML = `
    <div class="row compact">
      <span>Replay command</span>
      <code>${replay.replayCommand}</code>
    </div>
    <p class="subtle">Re-run with the same objective. Resume is not yet available.</p>
  `;
}

function renderBenchmarkLab() {
  const benchmark = data.benchmarkLab;
  document.querySelector("#benchmark-label").innerHTML = `<span class="pill neutral">${benchmark.seedLabel}</span>`;
  document.querySelector("#benchmark-summary").innerHTML = benchmark.summary
    .map(
      (item) => `
        <div class="summary-tile">
          <p class="metric-label">${item.label}</p>
          <p class="summary-value">${item.value}</p>
        </div>
      `
    )
    .join("");

  document.querySelector("#benchmark-table").innerHTML = benchmark.rows
    .map(
      (row) => `
        <div class="row">
          <div>
            <p><strong>${row.task}</strong></p>
            <p class="subtle">Ralph: ${row.ralph}</p>
            <p class="subtle">Martin: ${row.martin}</p>
          </div>
          <div class="stack-list end-align">
            <span class="pill ${toneClass(row.tone)}">${row.takeaway}</span>
          </div>
        </div>
      `
    )
    .join("");
}

function renderAll() {
  renderHeader();
  renderBudgetStrip();
  renderAttemptState();
  renderVerifierState();
  renderEffectivePolicy();
  renderExitOrientation();
  renderTimeline();
  renderBudgetPanel();
  renderVerifierPanel();
  renderInterventions();
  renderArtifacts();
  renderReplayPanel();
  renderBenchmarkLab();
}

loadData();
