import { ControlPlaneShell } from "../../components/control-plane-shell";
import { ExecutiveContextBar } from "../../components/executive-context-bar";
import { LabelLedger, Panel } from "../../components/dashboard-primitives";
import { TrustStrip } from "../../components/trust-strip";
import { getGovernancePageData } from "../../lib/queries/control-plane-queries";

export default async function GovernancePage() {
  const governance = await getGovernancePageData();

  return (
    <ControlPlaneShell title="Governance" eyebrow="Policy, approvals, and provenance">
      <ExecutiveContextBar
        workspaceLabel={governance.executiveContext.workspaceLabel}
        reportingWindow={governance.executiveContext.reportingWindow}
        policyProfile={governance.executiveContext.policyProfile}
        labels={governance.executiveContext.labels}
      />
      <TrustStrip items={governance.trustStrip} />
      <section className="overview-primary-grid">
        <Panel title="Effective policy controls">
          <div className="plain-list">
            {governance.policyRows.map((row) => (
              <article key={row.id} className="table-row stacked-row">
                <div>
                  <p className="table-title">{row.title}</p>
                  <p className="table-cell-muted">{row.value}</p>
                </div>
                <span className="status-pill tone-positive">{row.status}</span>
                <LabelLedger items={row.labels} className="compact-ledger" />
              </article>
            ))}
          </div>
        </Panel>
        <Panel title="Approval queue">
          <div className="plain-list">
            {governance.approvals.map((approval) => (
              <article key={approval.id} className="table-row stacked-row">
                <div>
                  <p className="table-title">{approval.title}</p>
                  <p className="table-cell-muted">{approval.summary}</p>
                  <p className="table-cell-muted">
                    Owner: {approval.owner} • Status: {approval.status}
                  </p>
                </div>
                <LabelLedger items={approval.labels} className="compact-ledger" />
              </article>
            ))}
          </div>
        </Panel>
      </section>
    </ControlPlaneShell>
  );
}
