import type { ReactNode } from 'react';

/** One term/value pair inside a `<dl className="grid grid-cols-[max-content_1fr] …">`. */
export function DetailRow({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}
