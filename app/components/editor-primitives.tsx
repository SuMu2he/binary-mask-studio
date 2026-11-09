import type { ReactNode } from 'react';

export function SectionHeading({ number, title }: { number: string; title: string }) {
  return <h2 className="panel-heading"><span>{number}</span>{title}</h2>;
}

export function FieldSuffix({ children }: { children: ReactNode }) { return <span className="field-suffix">{children}</span>; }
