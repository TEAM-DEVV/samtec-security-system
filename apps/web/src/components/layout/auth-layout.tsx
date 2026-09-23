import { cn } from 'cn';
import { Fingerprint, MapPin, Wallet } from 'lucide-react';
import type { ReactNode } from 'react';
import { BrandMark } from '@/components/brand-mark';
import { ChainPills } from '@/components/chain-pills';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { ThemeToggle } from './theme-toggle';

interface AuthLayoutProps {
  title: string;
  description: string;
  children: ReactNode;
}

// Written out in full (not built from the index) so Tailwind finds the class names.
const PROMISES = [
  {
    icon: Fingerprint,
    text: 'Every guard is enrolled once and proven unique.',
    delay: 'stagger-3',
  },
  {
    icon: MapPin,
    text: 'Every shift is a biometric clock-in at a known site.',
    delay: 'stagger-4',
  },
  {
    icon: Wallet,
    text: 'Every pesewa paid traces back to a verified presence.',
    delay: 'stagger-5',
  },
];

/**
 * The screens before sign-in: a brand stage on the left (a short band on
 * phones) and the task at hand in a card on the right.
 */
export function AuthLayout({ title, description, children }: AuthLayoutProps) {
  return (
    <main className="grid min-h-dvh bg-background text-foreground lg:grid-cols-[1.15fr_1fr]">
      <section
        aria-label="About SAMTEC"
        className="bg-stage relative flex flex-col justify-between overflow-hidden px-6 pt-6 pb-14 text-sidebar-foreground lg:p-12"
      >
        <div aria-hidden="true" className="bg-grid-faint absolute inset-0" />
        {/* Two slow lights drifting behind the words. Desktop only: blurred motion costs battery on phones. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-32 -left-24 hidden size-[28rem] rounded-full bg-gold/25 blur-3xl motion-safe:animate-drift lg:block"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-32 -bottom-40 hidden size-[30rem] rounded-full bg-sky-400/15 blur-3xl motion-safe:animate-float lg:block"
        />

        <div className="relative flex items-center gap-3 motion-safe:animate-rise">
          <BrandMark className="size-9 text-white" />
          <span className="font-heading font-semibold text-lg tracking-[0.18em]">SAMTEC</span>
          {/* On phones the card overlaps the top of the page, so the theme button lives up here. */}
          <div className="ml-auto lg:hidden">
            <ThemeToggle />
          </div>
        </div>

        <div className="relative mt-8 max-w-xl space-y-8 lg:mt-0">
          {/* Copy, not a heading: the page's one heading is the task in the card. */}
          <p className="stagger-1 font-heading font-semibold text-3xl leading-[1.05] tracking-tight motion-safe:animate-rise sm:text-4xl lg:text-5xl">
            From ghost payroll to{' '}
            <span className="text-gradient-gold motion-safe:animate-shine">proven presence.</span>
          </p>

          <ChainPills className="stagger-2 motion-safe:animate-rise" />

          <ul className="hidden space-y-4 text-sidebar-foreground/85 lg:block">
            {PROMISES.map(({ icon: Icon, text, delay }) => (
              <li
                key={text}
                className={cn('flex items-start gap-3 motion-safe:animate-rise', delay)}
              >
                <span className="mt-0.5 rounded-md border border-white/15 bg-white/[0.06] p-1.5">
                  <Icon aria-hidden="true" className="size-4 text-gold" />
                </span>
                <span>{text}</span>
              </li>
            ))}
          </ul>
        </div>

        <p className="stagger-6 relative hidden font-mono text-sidebar-foreground/55 text-xs motion-safe:animate-rise lg:block">
          Biometric attendance and payroll · Ghana
        </p>
      </section>

      <section className="relative flex items-start justify-center p-4 sm:items-center sm:p-8">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_100%_0%,color-mix(in_oklch,var(--gold)_12%,transparent),transparent_70%)]"
        />
        <div className="absolute top-3 right-3 hidden lg:block">
          <ThemeToggle />
        </div>
        <Card className="stagger-2 -mt-12 relative w-full max-w-sm shadow-xl motion-safe:animate-rise sm:mt-0">
          <CardHeader className="text-center">
            <h1 className="font-semibold text-xl leading-snug">{title}</h1>
            <CardDescription>{description}</CardDescription>
          </CardHeader>
          <CardContent>{children}</CardContent>
        </Card>
      </section>
    </main>
  );
}
