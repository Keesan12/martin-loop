import { LabelLedger, Panel, type LabeledDetail } from "./dashboard-primitives";

export interface TrendPoint {
  label: string;
  actualUsd: number;
  forecastUsd: number;
  modeledAvoidedUsd: number;
  budgetUsd: number;
}

export function PrimaryTrendPanel(props: {
  title: string;
  points: TrendPoint[];
  labels: LabeledDetail[];
}) {
  const maxValue = Math.max(
    ...props.points.flatMap((point) => [
      point.actualUsd,
      point.forecastUsd,
      point.modeledAvoidedUsd,
      point.budgetUsd
    ]),
    1
  );

  return (
    <Panel title={props.title} className="primary-trend-panel">
      <div className="trend-legend">
        <span className="legend-item actual">Actual</span>
        <span className="legend-item forecast">Forecast</span>
        <span className="legend-item modeled">Modeled avoided</span>
        <span className="legend-item budget">Budget</span>
      </div>
      <div className="dominant-chart" role="img" aria-label="Spend, forecast, and modeled avoidance chart">
        {props.points.map((point) => (
          <div key={point.label} className="dominant-chart-column">
            <div className="dominant-bars">
              <div className="dominant-bar actual" style={{ height: `${scale(point.actualUsd, maxValue)}px` }} />
              <div className="dominant-bar forecast" style={{ height: `${scale(point.forecastUsd, maxValue)}px` }} />
              <div
                className="dominant-bar modeled"
                style={{ height: `${scale(point.modeledAvoidedUsd, maxValue)}px` }}
              />
              <div className="dominant-bar budget" style={{ height: `${scale(point.budgetUsd, maxValue)}px` }} />
            </div>
            <p className="trend-label">{point.label}</p>
          </div>
        ))}
      </div>
      <LabelLedger items={props.labels} />
    </Panel>
  );
}

function scale(value: number, maxValue: number): number {
  return Math.max(10, Math.round((value / maxValue) * 190));
}
