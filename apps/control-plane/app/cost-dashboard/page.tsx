import { ControlPlaneShell } from "../../components/control-plane-shell";
import { ExecutiveContextBar } from "../../components/executive-context-bar";
import { OverviewKpiBand } from "../../components/overview-kpi-band";
import { PrimaryTrendPanel } from "../../components/primary-trend-panel";
import { getEconomicsPageData } from "../../lib/queries/control-plane-queries";

export default async function CostDashboardPage() {
  const data = await getEconomicsPageData();

  return (
    <ControlPlaneShell
      title="Cost Dashboard"
      eyebrow="Savings, efficiency, and model routing"
      activeNavLabel="Cost Dashboard"
    >
      <ExecutiveContextBar
        workspaceLabel={data.executiveContext.workspaceLabel}
        reportingWindow={data.executiveContext.reportingWindow}
        policyProfile={data.executiveContext.policyProfile}
        labels={data.executiveContext.labels}
      />
      <OverviewKpiBand items={data.kpiBand} />
      <PrimaryTrendPanel
        title="Spend, forecast, and modeled avoidance"
        points={data.primaryTrend.points}
        labels={data.primaryTrend.labels}
      />
    </ControlPlaneShell>
  );
}
