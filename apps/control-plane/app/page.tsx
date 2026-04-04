import { ControlPlaneShell } from "../components/control-plane-shell";
import { ExceptionPanel } from "../components/exception-panel";
import { ExecutiveContextBar } from "../components/executive-context-bar";
import { OverviewKpiBand } from "../components/overview-kpi-band";
import { PrimaryTrendPanel } from "../components/primary-trend-panel";
import { TrustStrip } from "../components/trust-strip";
import { getOverviewPageData } from "../lib/queries/control-plane-queries";

export default async function OverviewPage() {
  const overview = await getOverviewPageData();

  return (
    <ControlPlaneShell title="Overview" eyebrow="Executive control room">
      <ExecutiveContextBar
        workspaceLabel={overview.executiveContext.workspaceLabel}
        reportingWindow={overview.executiveContext.reportingWindow}
        policyProfile={overview.executiveContext.policyProfile}
        labels={overview.executiveContext.labels}
      />
      <OverviewKpiBand items={overview.kpiBand} />
      <TrustStrip items={overview.trustStrip} />
      <section className="overview-primary-grid">
        <PrimaryTrendPanel
          title="Daily savings vs would-have-spent"
          points={overview.primaryTrend.points}
          labels={overview.primaryTrend.labels}
        />
        <ExceptionPanel title="Exceptions" rows={overview.exceptions} />
      </section>
    </ControlPlaneShell>
  );
}
