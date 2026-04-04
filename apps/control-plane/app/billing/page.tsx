import { ControlPlaneShell } from "../../components/control-plane-shell";
import { Panel } from "../../components/dashboard-primitives";
import { getBillingPageData } from "../../lib/queries/control-plane-queries";

export default async function BillingPage() {
  const data = await getBillingPageData();

  return (
    <ControlPlaneShell title="Billing" eyebrow="Usage and reconciliation">
      <div className="two-up">
        <Panel title="Current account">
          {data.account ? (
            <div className="plain-list">
              <div className="table-row">
                <div>
                  <p className="table-title">{data.account.planName}</p>
                  <p className="table-cell-muted">Commit ${data.account.monthlyCommitUsd.toLocaleString()}</p>
                </div>
              </div>
              <div className="table-row">
                <div>
                  <p className="table-title">Forecast spend</p>
                  <p className="table-cell-muted">${data.account.forecastSpendUsd.toLocaleString()}</p>
                </div>
              </div>
              <div className="table-row">
                <div>
                  <p className="table-title">Realized savings</p>
                  <p className="table-cell-muted">${data.account.realizedSavingsUsd.toLocaleString()}</p>
                </div>
              </div>
            </div>
          ) : (
            <p className="table-cell-muted">No billing profile yet. Add a workspace row in Supabase to populate this panel.</p>
          )}
        </Panel>
        <Panel title="Invoices">
          <div className="plain-list">
            {(data.account?.invoices ?? []).map((invoice) => (
              <div key={invoice.invoiceId} className="table-row">
                <div>
                  <p className="table-title">{invoice.month}</p>
                  <p className="table-cell-muted">${invoice.amountUsd.toLocaleString()}</p>
                </div>
                <span
                  className={`status-pill tone-${
                    invoice.status === "Paid" ? "positive" : invoice.status === "Due" ? "warning" : "neutral"
                  }`}
                >
                  {invoice.status}
                </span>
              </div>
            ))}
            {(data.account?.invoices ?? []).length === 0 ? (
              <p className="table-cell-muted">No invoices yet.</p>
            ) : null}
          </div>
        </Panel>
      </div>
    </ControlPlaneShell>
  );
}
