import { cn } from 'cn';

/** The three links of the chain, in the order the system proves them. */
const CHAIN = ['identity', 'presence', 'pay'];

/**
 * identity → presence → pay as three small pills joined by gold lines. Meant
 * for the navy surfaces (the sign-in stage and the overview banner).
 */
export function ChainPills({ className }: { className?: string }) {
  return (
    <ol className={cn('flex flex-wrap items-center gap-2 font-mono text-xs', className)}>
      {CHAIN.map((link, index) => (
        <li key={link} className="flex items-center gap-2">
          <span className="rounded-full border border-white/20 bg-white/[0.06] px-3 py-1 uppercase tracking-[0.16em]">
            {link}
          </span>
          {index < CHAIN.length - 1 && (
            <span aria-hidden="true" className="h-px w-5 bg-linear-to-r from-gold/80 to-white/20" />
          )}
        </li>
      ))}
    </ol>
  );
}
