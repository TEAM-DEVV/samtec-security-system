import type { DetectionRule } from '@samtec/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Link } from 'react-router';
import { routes } from '@/app/routes';
import { DetailRow } from '@/components/detail-row';
import { SeverityBadge } from '@/components/detection-badges';
import { LoadErrorAlert } from '@/components/load-error-alert';
import { PageHeader } from '@/components/page-header';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { $api } from '@/lib/api';
import { thresholdLabels } from '@/lib/detection';
import { formatDateTime } from '@/lib/format';
import { usePageTitle } from '@/lib/page-title';
import { describeApiError } from '@/lib/problem';
import { pageRoles, roleAllowed } from '@/lib/roles';
import { useSession } from '@/lib/session';

/**
 * The eleven rules and the numbers each one starts from
 * (docs/plan/08-ghost-detection-engine.md §2). An administrator can switch a
 * rule off or move its numbers without a deploy; the report's tuning table is
 * built by doing exactly that and watching the queue change.
 */
export function DetectionRulesPage() {
  usePageTitle('Detection rules');
  const session = useSession();
  const mayChange = session !== null && roleAllowed(pageRoles.detectionChanges, session.user.role);
  const rules = $api.useQuery('get', '/detection/rules');

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <Link
        to={routes.detection}
        className="flex w-fit items-center gap-1 text-muted-foreground text-sm hover:text-foreground"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        Alerts
      </Link>

      <PageHeader
        eyebrow="Phase 5 · Ghost detection"
        title="Rules"
        description={
          mayChange
            ? 'Switch a rule off, or move its numbers. A change applies from the next run; alerts already raised stay as they were.'
            : 'The rules and the numbers they use. Only an administrator changes them.'
        }
      />

      {rules.isError ? (
        <LoadErrorAlert
          title="The rules could not be loaded"
          error={rules.error}
          retrying={rules.isFetching}
          onRetry={() => void rules.refetch()}
        />
      ) : rules.isPending ? (
        <div className="grid gap-4">
          <span role="status" className="sr-only">
            Loading the rules…
          </span>
          <Skeleton aria-hidden="true" className="h-40 w-full" />
          <Skeleton aria-hidden="true" className="h-40 w-full" />
        </div>
      ) : rules.data.items.length === 0 ? (
        <Alert>
          <AlertTitle>No rules</AlertTitle>
          <AlertDescription>The engine has no rules in its catalogue.</AlertDescription>
        </Alert>
      ) : (
        <div className="grid gap-4">
          {rules.data.items.map((rule) => (
            <RuleCard key={rule.code} rule={rule} mayChange={mayChange} />
          ))}
        </div>
      )}
    </div>
  );
}

function RuleCard({ rule, mayChange }: { rule: DetectionRule; mayChange: boolean }) {
  const headingId = `rule-${rule.code}-heading`;
  const thresholdNames = Object.keys(rule.thresholds);

  return (
    <Card
      role="region"
      aria-labelledby={headingId}
      className="rounded-2xl motion-safe:animate-rise-soft"
    >
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle id={headingId} className="font-heading text-lg">
            <span className="font-mono">{rule.code}</span> · {rule.name}
          </CardTitle>
          <span className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={rule.severity} />
            <Badge variant="outline" className="font-medium">
              {rule.enabled ? 'On' : 'Off'}
            </Badge>
          </span>
        </div>
        <CardDescription>{rule.description}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {mayChange ? (
          <>
            <ToggleButton rule={rule} />
            {thresholdNames.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No numbers to tune: this rule is a fact, not a gradient.
              </p>
            ) : (
              <ThresholdForm rule={rule} />
            )}
          </>
        ) : thresholdNames.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No numbers to tune: this rule is a fact, not a gradient.
          </p>
        ) : (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
            {thresholdNames.map((name) => (
              <DetailRow key={name} term={thresholdLabels[name] ?? name}>
                <span className="tabular-nums">{String(rule.thresholds[name])}</span>
              </DetailRow>
            ))}
          </dl>
        )}
        <p className="text-muted-foreground text-xs tabular-nums">
          Last changed {formatDateTime(rule.updatedAt)}
        </p>
      </CardContent>
    </Card>
  );
}

function ToggleButton({ rule }: { rule: DetectionRule }) {
  const queryClient = useQueryClient();
  const change = $api.useMutation('patch', '/detection/rules/{ruleCode}', {
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['get', '/detection/rules'] });
    },
  });
  const problem = change.error ? describeApiError(change.error) : undefined;

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={change.isPending}
        aria-label={`Switch ${rule.enabled ? 'off' : 'on'} ${rule.code}`}
        onClick={() =>
          change.mutate({
            params: { path: { ruleCode: rule.code } },
            body: { enabled: !rule.enabled },
          })
        }
      >
        {change.isPending ? 'Saving…' : rule.enabled ? 'Switch off' : 'Switch on'}
      </Button>
      {!rule.enabled && (
        <span className="text-muted-foreground text-xs">
          Skipped by every run until it is switched on again.
        </span>
      )}
      {problem && (
        <span role="alert" className="text-destructive text-xs">
          {problem.message}
        </span>
      )}
    </div>
  );
}

function ThresholdForm({ rule }: { rule: DetectionRule }) {
  const queryClient = useQueryClient();
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.entries(rule.thresholds).map(([name, value]) => [name, String(value)]),
    ),
  );
  const [mistake, setMistake] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const change = $api.useMutation('patch', '/detection/rules/{ruleCode}', {
    onSuccess: () => {
      setSaved(true);
      void queryClient.invalidateQueries({ queryKey: ['get', '/detection/rules'] });
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (change.isPending) {
      return;
    }
    const thresholds: Record<string, number> = {};
    for (const [name, text] of Object.entries(values)) {
      const number = Number(text.trim());
      if (text.trim() === '' || !Number.isFinite(number) || number < 0) {
        setMistake(`${thresholdLabels[name] ?? name} must be a whole number, zero or more.`);
        return;
      }
      thresholds[name] = number;
    }
    setMistake(null);
    change.mutate({ params: { path: { ruleCode: rule.code } }, body: { thresholds } });
  }

  const problem = change.error ? describeApiError(change.error) : undefined;

  return (
    <form noValidate onSubmit={submit} aria-busy={change.isPending} className="grid gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {Object.entries(values).map(([name, text]) => {
          const id = `${rule.code}-${name}`;
          return (
            <div key={name} className="grid gap-1.5">
              <Label htmlFor={id}>{thresholdLabels[name] ?? name}</Label>
              <Input
                id={id}
                type="number"
                inputMode="numeric"
                min={0}
                value={text}
                onChange={(event) => {
                  setSaved(false);
                  setValues((current) => ({ ...current, [name]: event.target.value }));
                }}
              />
            </div>
          );
        })}
      </div>

      {mistake && (
        <Alert variant="destructive">
          <AlertDescription>{mistake}</AlertDescription>
        </Alert>
      )}
      {problem && (
        <Alert variant="destructive">
          <AlertTitle>Could not save {rule.code}</AlertTitle>
          <AlertDescription>
            <p>{problem.message}</p>
            {problem.traceId && <p className="font-mono text-xs">Trace ID: {problem.traceId}</p>}
          </AlertDescription>
        </Alert>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" aria-label={`Save ${rule.code}`}>
          {change.isPending ? 'Saving…' : 'Save'}
        </Button>
        {saved && (
          <span role="status" className="text-muted-foreground text-xs">
            Saved. Applies from the next run.
          </span>
        )}
      </div>
    </form>
  );
}
