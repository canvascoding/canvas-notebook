import type { ReactNode } from 'react';

export function WidgetField({ label, children }: { label: string; children: ReactNode }) {
  return <div className="widget-field"><dt>{label}</dt><dd>{children}</dd></div>;
}

export function WidgetShell({ title, status, children }: { title: string; status: string; children: ReactNode }) {
  return <main className="widget-shell">
    <header><p className="widget-eyebrow">{title}</p><span className="widget-badge">{status}</span></header>
    {children}
  </main>;
}
