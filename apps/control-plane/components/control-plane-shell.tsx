import type { ReactNode } from "react";

import { getNavigationItems } from "../lib/queries/control-plane-queries";

export function ControlPlaneShell(props: {
  title: string;
  eyebrow: string;
  activeNavLabel?: string;
  children: ReactNode;
}) {
  const navigation = getNavigationItems();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-mark">ML</div>
        <div>
          <p className="eyebrow">Martin Loop</p>
          <h1 className="sidebar-title">Control Plane</h1>
        </div>
        <nav className="sidebar-nav">
          {navigation.map((item) => (
            <a
              key={item.href}
              className={`sidebar-link ${item.label === (props.activeNavLabel ?? props.title) ? "is-active" : ""}`}
              href={item.href}
              aria-current={item.label === (props.activeNavLabel ?? props.title) ? "page" : undefined}
            >
              {item.label}
            </a>
          ))}
        </nav>
      </aside>
      <main className="content">
        <div className="page-header">
          <p className="eyebrow">{props.eyebrow}</p>
          <h2 className="page-title">{props.title}</h2>
        </div>
        {props.children}
      </main>
    </div>
  );
}
