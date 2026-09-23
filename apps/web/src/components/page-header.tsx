import type { ReactNode } from 'react';

interface PageHeaderProps {
  title: string;
  description?: string;
  /** A small label above the title, for example "Phase 1 · Workforce". */
  eyebrow?: string;
  /** Buttons or links shown on the right, for example "Add employee". */
  actions?: ReactNode;
}

/** The heading every page starts with, so titles and spacing look the same everywhere. */
export function PageHeader({ title, description, eyebrow, actions }: PageHeaderProps) {
  return (
    <header className="flex flex-wrap items-end justify-between gap-4">
      <div className="space-y-1">
        {eyebrow && (
          <p className="font-medium text-[11px] text-gold-foreground/70 uppercase tracking-[0.2em] dark:text-gold/80">
            {eyebrow}
          </p>
        )}
        <h1 className="font-semibold text-3xl tracking-tight">{title}</h1>
        {description && <p className="text-muted-foreground text-sm">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}
