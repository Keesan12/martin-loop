import { ControlPlaneShell } from "../../components/control-plane-shell";
import { Panel } from "../../components/dashboard-primitives";
import { getSettingsPageData } from "../../lib/queries/control-plane-queries";

export default async function SettingsPage() {
  const data = await getSettingsPageData();

  return (
    <ControlPlaneShell title="Admin" eyebrow="Workspace administration">
      <section className="two-up">
        <Panel title="Workspace profile">
          {data.workspace ? (
            <div className="plain-list">
              <div className="table-row">
                <div>
                  <p className="table-title">{data.workspace.name}</p>
                  <p className="table-cell-muted">Primary contact: {data.workspace.primaryContact}</p>
                  <p className="table-cell-muted">Billing email: {data.workspace.billingEmail}</p>
                </div>
              </div>
              <div className="table-row">
                <div>
                  <p className="table-title">Operating cadence</p>
                  <p className="table-cell-muted">{data.workspace.operatingCadence}</p>
                </div>
              </div>
            </div>
          ) : (
            <p className="table-cell-muted">No workspace profile row yet.</p>
          )}
        </Panel>

        <Panel title="Role distribution">
          <div className="plain-list">
            {data.roles.map((role) => (
              <div key={role.label} className="table-row">
                <div>
                  <p className="table-title">{role.label}</p>
                  <p className="table-cell-muted">Active seats: {role.count}</p>
                </div>
              </div>
            ))}
            {data.roles.length === 0 ? (
              <p className="table-cell-muted">No role distribution data yet.</p>
            ) : null}
          </div>
        </Panel>
      </section>
    </ControlPlaneShell>
  );
}
