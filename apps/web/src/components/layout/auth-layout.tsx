import type { ReactNode } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface AuthLayoutProps {
  title: string;
  description: string;
  children: ReactNode;
}

/** The centred card used by every screen before sign-in: no sidebar, just the task at hand. */
export function AuthLayout({ title, description, children }: AuthLayoutProps) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background p-4 text-foreground">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <img src="/favicon.svg" alt="" className="mx-auto mb-2 size-10" />
          <CardTitle className="text-xl">{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </main>
  );
}
