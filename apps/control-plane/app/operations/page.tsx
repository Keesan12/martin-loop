import { ControlPlaneShell } from "../../components/control-plane-shell";
import { ExceptionPanel } from "../../components/exception-panel";
import { ExecutiveContextBar } from "../../components/executive-context-bar";
import { LabelLedger, Panel } from "../../components/dashboard-primitives";
import { OverviewKpiBand } from "../../components/overview-kpi-band";
import { TrustStrip } from "../../components/trust-strip";
import { getOperationsPageData } from "../../lib/queries/control-plane-queries";

export default async function OperationsPage() {
  const operations = await getOperationsPageData();

  return (
    <ControlPlaneShell title="Operations" eyebrow="Run health and intervention posture">
      <ExecutiveContextBar
        workspaceLabel={operations.executiveContext.workspaceLabel}
        reportingWindow={operations.executiveContext.reportingWindow}
        policyProfile={operations.executiveContext.policyProfile}
        labels={operations.executiveContext.labels}
      />
      <OverviewKpiBand items={operations.kpiBand} />
      <TrustStrip items={operations.trustStrip} />
      <section className="overview-primary-grid">
        <ExceptionPanel title="Operational exceptions" rows={operations.exceptions} />
        <Panel title="Focus areas">
          <div className="plain-list">
            {operations.focusAreas.map((area) => (
              <article key={area.title} className="table-row stacked-row">
                <div>
                  <p className="table-title">{area.title}</p>
                  <p className="table-cell-muted">{area.summary}</p>
                  <p className="table-cell-muted">
                    Owner: {area.owner} • Status: {area.status}
                  </p>
                </div>
                <LabelLedger items={area.labels} className="compact-ledger" />
              </article>
            ))}
          </div>
        </Panel>
      </section>
    </ControlPlaneShell>
  );
}
