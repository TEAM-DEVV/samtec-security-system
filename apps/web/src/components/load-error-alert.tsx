import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { describeApiError, isWorthRetrying } from '@/lib/problem';

interface LoadErrorAlertProps {
  /** What could not be loaded, for example "Employees could not be loaded". */
  title: string;
  error: unknown;
  onRetry: () => void;
  /** True while the retry is running, so the button says so. */
  retrying?: boolean;
}

/**
 * The error state every screen that loads data shows: the API's own message,
 * the trace ID for the logs, and a retry — but only when retrying can help
 * (a 400 or 404 would just fail the same way again).
 */
export function LoadErrorAlert({ title, error, onRetry, retrying = false }: LoadErrorAlertProps) {
  const { message, traceId } = describeApiError(error);
  return (
    <Alert variant="destructive">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="space-y-2">
        <p>{message}</p>
        {traceId && <p className="font-mono text-xs">Trace ID: {traceId}</p>}
        {isWorthRetrying(error) && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            {retrying ? 'Trying again…' : 'Try again'}
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}
