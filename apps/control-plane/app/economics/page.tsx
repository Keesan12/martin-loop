import { ControlPlaneShell } from "../../components/control-plane-shell";
import { ExecutiveContextBar } from "../../components/executive-context-bar";
import { Panel } from "../../components/dashboard-primitives";
import { OverviewKpiBand } from "../../components/overview-kpi-band";
import { PrimaryTrendPanel } from "../../components/primary-trend-panel";
import { getEconomicsPageData } from "../../lib/queries/control-plane-queries";

export default async function EconomicsPage() {
  const economics = await getEconomicsPageData();

  return (
    <ControlPlaneShell title="Economics" eyebrow="Spend, forecast, and modeled ROI">
      <ExecutiveContextBar
        workspaceLabel={economics.executiveContext.workspaceLabel}
        reportingWindow={economics.executiveContext.reportingWindow}
        policyProfile={economics.executiveContext.policyProfile}
        labels={economics.executiveContext.labels}
      />
      <OverviewKpiBand items={economics.kpiBand} />
      <PrimaryTrendPanel
        title="Spend, forecast, and modeled avoidance"
        points={economics.primaryTrend.points}
        labels={economics.primaryTrend.labels}
      />
      <Panel title="Methodology notes">
        <div className="plain-list">
          {economics.methodologyNotes.map((note) => (
            <article key={note} className="table-row">
              <p className="table-cell-muted">{note}</p>
            </article>
          ))}
        </div>
      </Panel>
    </ControlPlaneShell>
  );
}
