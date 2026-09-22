import { Fingerprint, MapPin, Wallet } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { ThemeToggle } from './theme-toggle';

interface AuthLayoutProps {
  title: string;
  description: string;
  children: ReactNode;
}

const PROMISES = [
  { icon: Fingerprint, text: 'Every guard is enrolled once and proven unique.' },
  { icon: MapPin, text: 'Every shift is a biometric clock-in at a known site.' },
  { icon: Wallet, text: 'Every pesewa paid traces back to a verified presence.' },
];

/**
 * The screens before sign-in: a brand panel on the left (hidden on phones)
 * and the task at hand in a card on the right.
 */
export function AuthLayout({ title, description, children }: AuthLayoutProps) {
  return (
    <main className="grid min-h-dvh bg-background text-foreground lg:grid-cols-[1.1fr_1fr]">
      <section
        aria-label="About SAMTEC"
        className="hidden flex-col justify-between bg-sidebar p-10 text-sidebar-foreground lg:flex"
      >
        <div className="flex items-center gap-3">
          <img src="/favicon.svg" alt="" className="size-9" />
          <span className="font-semibold text-lg tracking-wide">SAMTEC</span>
        </div>
        <div className="max-w-md space-y-8">
          {/* Copy, not a heading: the page's one heading is the task in the card. */}
          <p className="font-semibold text-3xl leading-tight tracking-tight">
            From ghost payroll to proven presence.
          </p>
          <ul className="space-y-4 text-sidebar-foreground/85">
            {PROMISES.map(({ icon: Icon, text }) => (
              <li key={text} className="flex items-start gap-3">
                <Icon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-sidebar-primary" />
                <span>{text}</span>
              </li>
            ))}
          </ul>
        </div>
        <p className="font-mono text-sidebar-foreground/60 text-xs">identity → presence → pay</p>
      </section>

      <section className="relative flex items-center justify-center p-4 sm:p-8">
        <div className="absolute top-3 right-3">
          <ThemeToggle />
        </div>
        <Card className="w-full max-w-sm">
          <CardHeader className="text-center">
            <img src="/favicon.svg" alt="" className="mx-auto mb-2 size-10 lg:hidden" />
            <h1 className="font-semibold text-xl leading-snug">{title}</h1>
            <CardDescription>{description}</CardDescription>
          </CardHeader>
          <CardContent>{children}</CardContent>
        </Card>
      </section>
    </main>
  );
}
