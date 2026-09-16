import { Construction } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

interface ComingInPhasePageProps {
  title: string;
  /** The roadmap phase in which the real API gets this page's endpoints. */
  phase: number;
}

/**
 * Stands in for a page whose API endpoints are not built yet. The page itself
 * already works with the mock API, so the dashboard can be built first.
 */
export function ComingInPhasePage({ title, phase }: ComingInPhasePageProps) {
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <h1 className="font-semibold text-2xl tracking-tight">{title}</h1>
      <Alert>
        <Construction aria-hidden="true" />
        <AlertTitle>The real API gets this page in Phase {phase}</AlertTitle>
        <AlertDescription>
          <p>
            Until then, this page works with mock data only. Run <code>pnpm dev:web</code> to use
            it.
          </p>
        </AlertDescription>
      </Alert>
    </div>
  );
}
