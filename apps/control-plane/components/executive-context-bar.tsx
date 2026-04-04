import { LabelLedger, type LabeledDetail } from "./dashboard-primitives";

export function ExecutiveContextBar(props: {
  workspaceLabel: string;
  reportingWindow: string;
  policyProfile: string;
  labels: LabeledDetail[];
}) {
  return (
    <section className="card executive-context-bar" aria-label="Executive context">
      <div className="panel-header">
        <h3>Executive context</h3>
      </div>
      <div className="context-grid">
        <article>
          <p className="metric-label">Workspace</p>
          <p className="context-value">{props.workspaceLabel}</p>
        </article>
        <article>
          <p className="metric-label">Reporting window</p>
          <p className="context-value">{props.reportingWindow}</p>
        </article>
        <article>
          <p className="metric-label">Policy profile</p>
          <p className="context-value">{props.policyProfile}</p>
        </article>
      </div>
      <LabelLedger items={props.labels} />
    </section>
  );
}
