import { LabelLedger, type LabeledDetail } from "./dashboard-primitives";

export interface OverviewKpiItem {
  label: string;
  value: string;
  delta: string;
  tone?: "positive" | "neutral" | "warning";
  labels: LabeledDetail[];
}

export function OverviewKpiBand(props: { items: OverviewKpiItem[] }) {
  return (
    <section className="kpi-band" aria-label="KPI band">
      {props.items.map((item) => (
        <article key={item.label} className="card kpi-card">
          <p className="metric-label">{item.label}</p>
          <p className="metric-value">{item.value}</p>
          <p className={`metric-delta tone-${item.tone ?? "neutral"}`}>{item.delta}</p>
          <LabelLedger items={item.labels} />
        </article>
      ))}
    </section>
  );
}
