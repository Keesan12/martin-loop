import { LabelLedger, Panel, type LabeledDetail } from "./dashboard-primitives";

export interface ExceptionRow {
  id: string;
  title: string;
  summary: string;
  severity: "High" | "Medium" | "Low";
  owner: string;
  dueBy: string;
  labels: LabeledDetail[];
}

export function ExceptionPanel(props: { title: string; rows: ExceptionRow[] }) {
  return (
    <Panel title={props.title} className="exception-panel">
      <div className="exception-list">
        {props.rows.map((row) => (
          <article key={row.id} className="exception-row">
            <div>
              <p className="table-title">{row.title}</p>
              <p className="table-cell-muted">{row.summary}</p>
              <p className="table-cell-muted">
                Owner: {row.owner} • Due: {row.dueBy}
              </p>
            </div>
            <span className={`status-pill tone-${toneForSeverity(row.severity)}`}>{row.severity}</span>
            <LabelLedger items={row.labels} className="compact-ledger" />
          </article>
        ))}
      </div>
    </Panel>
  );
}

function toneForSeverity(severity: ExceptionRow["severity"]): "danger" | "warning" | "neutral" {
  if (severity === "High") return "danger";
  if (severity === "Medium") return "warning";
  return "neutral";
}
