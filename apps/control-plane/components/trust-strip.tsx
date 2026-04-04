import { LabelLedger, type LabeledDetail } from "./dashboard-primitives";

export interface TrustStripItem {
  label: string;
  value: string;
  labels: LabeledDetail[];
}

export function TrustStrip(props: { items: TrustStripItem[] }) {
  return (
    <section className="card trust-strip" aria-label="Trust strip">
      <div className="panel-header">
        <h3>Trust strip</h3>
      </div>
      <div className="trust-strip-grid">
        {props.items.map((item) => (
          <article key={item.label} className="trust-cell">
            <p className="metric-label">{item.label}</p>
            <p className="trust-value">{item.value}</p>
            <LabelLedger items={item.labels} className="compact-ledger" />
          </article>
        ))}
      </div>
    </section>
  );
}
