import type { ReactNode } from "react";

export interface LabeledDetail {
  label: string;
  value: string;
}

export function MetricCard(props: {
  label: string;
  value: string;
  delta: string;
  tone?: "positive" | "neutral" | "warning";
}) {
  return (
    <section className="card metric-card">
      <p className="metric-label">{props.label}</p>
      <p className="metric-value">{props.value}</p>
      <p className={`metric-delta tone-${props.tone ?? "neutral"}`}>{props.delta}</p>
    </section>
  );
}

export function Panel(props: { title: string; children: ReactNode; className?: string }) {
  return (
    <section className={`card panel ${props.className ?? ""}`.trim()}>
      <div className="panel-header">
        <h3>{props.title}</h3>
      </div>
      {props.children}
    </section>
  );
}

export function TrendBars(props: { points: Array<{ label: string; savedUsd: number; spendUsd: number }> }) {
  const maxValue = Math.max(...props.points.map((point) => point.savedUsd), 1);

  return (
    <div className="trend-bars">
      {props.points.map((point) => (
        <div key={point.label} className="trend-column">
          <div
            className="trend-bar trend-bar-spend"
            style={{ height: `${Math.round((point.spendUsd / maxValue) * 180)}px` }}
          />
          <div
            className="trend-bar trend-bar-save"
            style={{ height: `${Math.round((point.savedUsd / maxValue) * 220)}px` }}
          />
          <span className="trend-label">{point.label}</span>
        </div>
      ))}
    </div>
  );
}

export function StatusTable(props: {
  rows: Array<{ title: string; subtitle: string; tone: "positive" | "warning" | "danger"; meta: string }>;
}) {
  return (
    <div className="status-table">
      {props.rows.map((row) => (
        <div key={row.title} className="status-row">
          <div>
            <p className="status-title">{row.title}</p>
            <p className="status-subtitle">{row.subtitle}</p>
          </div>
          <div className="status-meta">
            <span className={`status-pill tone-${row.tone}`}>{row.meta}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

export function LabelLedger(props: { items: LabeledDetail[]; className?: string }) {
  if (props.items.length === 0) {
    return null;
  }

  return (
    <dl className={`label-ledger ${props.className ?? ""}`.trim()}>
      {props.items.map((item) => (
        <div key={`${item.label}:${item.value}`} className="label-ledger-row">
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
