import type {
  DetectionAlert,
  DetectionAlertList,
  DetectionAlertStatus,
  DetectionRuleCode,
  DetectionSeverity,
  DetectionSweepResult,
} from '@samtec/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { cn } from 'cn';
import { RefreshCw, ShieldCheck, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { routes } from '@/app/routes';
import { AlertStatusBadge, RuleBadge, SeverityBadge } from '@/components/detection-badges';
import { LoadErrorAlert } from '@/components/load-error-alert';
import { PageHeader } from '@/components/page-header';
import { PaginationNav } from '@/components/pagination-nav';
import { SelectField } from '@/components/select-field';
import { useSiteNames } from '@/components/site-select';
import { TableEmptyRow, TableLoadingRows } from '@/components/table-states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { $api } from '@/lib/api';
import { useCursorPages } from '@/lib/cursor-pages';
import {
  ALERT_STATUSES,
  alertStatusLabels,
  isAlertStatus,
  isRuleCode,
  isSeverity,
  RULE_CODES,
  ruleLabels,
  SEVERITIES,
  severityLabels,
} from '@/lib/detection';
import { formatDateTime } from '@/lib/format';
import { usePageTitle } from '@/lib/page-title';
import { describeApiError } from '@/lib/problem';
import { pageRoles, roleAllowed } from '@/lib/roles';
import { useSession } from '@/lib/session';

const PAGE_SIZE = 20;
const COLUMN_COUNT = 6;
/** How many people the "highest risk" panel names. */
const RISK_LIST_SIZE = 5;

/**
 * The ghost-detection queue (docs/plan/08-ghost-detection-engine.md): every
 * question a rule has raised, open ones first. A rule never decides anything
 * about a person — each row opens the evidence, and a person answers.
 */
export function DetectionPage() {
  usePageTitle('Ghost detection');
  const session = useSession();
  const mayRunRules =
    session !== null && roleAllowed(pageRoles.detectionChanges, session.user.role);
  const [status, setStatus] = useState<DetectionAlertStatus>('OPEN');
  const [ruleCode, setRuleCode] = useState<DetectionRuleCode>();
  const [severity, setSeverity] = useState<DetectionSeverity>();
  const pages = useCursorPages();
  const siteNames = useSiteNames();

  const alerts = $api.useQuery(
    'get',
    '/detection/alerts',
    {
      params: {
        query: { status, ruleCode, severity, limit: PAGE_SIZE, cursor: pages.cursor },
      },
    },
    { placeholderData: (previous) => previous },
  );
  const showingOldPage = alerts.isPlaceholderData;
  const nextCursor = alerts.error ? null : (alerts.data?.nextCursor ?? null);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <PageHeader
        eyebrow="Phase 5 · Ghost detection"
        title="Alerts"
        description="Questions the rules have raised about a worker, a device or a decision. Nothing here is a verdict: open one, read the evidence, and record what you found."
        actions={
          <>
            <Button asChild variant="outline">
              <Link to={routes.detectionRules}>
                <SlidersHorizontal aria-hidden="true" />
                Rules
              </Link>
            </Button>
            {mayRunRules && <SweepButton />}
          </>
        }
      />

      <HighestRisk />

      <div className="flex flex-wrap items-start gap-4 rounded-2xl border bg-card/60 p-4">
        <SelectField
          id="alerts-status"
          label="Status"
          value={status}
          onChange={(value) => {
            if (isAlertStatus(value)) {
              setStatus(value);
              pages.reset();
            }
          }}
        >
          {ALERT_STATUSES.map((value) => (
            <option key={value} value={value}>
              {alertStatusLabels[value]}
            </option>
          ))}
        </SelectField>
        <SelectField
          id="alerts-rule"
          label="Rule"
          value={ruleCode ?? ''}
          onChange={(value) => {
            setRuleCode(isRuleCode(value) ? value : undefined);
            pages.reset();
          }}
        >
          <option value="">All rules</option>
          {RULE_CODES.map((code) => (
            <option key={code} value={code}>
              {code} · {ruleLabels[code]}
            </option>
          ))}
        </SelectField>
        <SelectField
          id="alerts-severity"
          label="Severity"
          value={severity ?? ''}
          onChange={(value) => {
            setSeverity(isSeverity(value) ? value : undefined);
            pages.reset();
          }}
        >
          <option value="">All severities</option>
          {SEVERITIES.map((value) => (
            <option key={value} value={value}>
              {severityLabels[value]}
            </option>
          ))}
        </SelectField>
      </div>

      {alerts.error ? (
        <LoadErrorAlert
          title="The alerts could not be loaded"
          error={alerts.error}
          retrying={alerts.isFetching}
          onRetry={() => void alerts.refetch()}
        />
      ) : (
        <Card
          aria-busy={showingOldPage}
          className={cn(
            'overflow-hidden rounded-2xl py-0 transition-opacity motion-safe:animate-rise-soft',
            showingOldPage && 'opacity-60',
          )}
        >
          <Table>
            <TableHeader>
              <TableRow className="bg-muted/50 hover:bg-muted/50 [&_th]:text-[11px] [&_th]:text-muted-foreground [&_th]:uppercase [&_th]:tracking-[0.14em]">
                <TableHead className="pl-4">Raised</TableHead>
                <TableHead>Rule</TableHead>
                <TableHead>Severity</TableHead>
                <TableHead>About</TableHead>
                <TableHead>Site</TableHead>
                <TableHead className="pr-4" />
              </TableRow>
            </TableHeader>
            <TableBody>
              <AlertRows
                loading={alerts.isPending}
                page={alerts.data}
                siteNames={siteNames}
                filtered={ruleCode !== undefined || severity !== undefined || status !== 'OPEN'}
              />
            </TableBody>
          </Table>
        </Card>
      )}

      <PaginationNav pages={pages} nextCursor={nextCursor} busy={showingOldPage} />
    </div>
  );
}

/**
 * "Run the rules now": the same sweep the daily job runs. Repeating it is
 * harmless — a finding already raised is not raised twice, and one a person
 * closed is never reopened — so the button can be pressed freely.
 */
function SweepButton() {
  const queryClient = useQueryClient();
  const [result, setResult] = useState<DetectionSweepResult | null>(null);
  const sweep = $api.useMutation('post', '/detection/sweep', {
    onSuccess: (ran) => {
      setResult(ran);
      void queryClient.invalidateQueries({ queryKey: ['get', '/detection/alerts'] });
      void queryClient.invalidateQueries({ queryKey: ['get', '/detection/risk-scores'] });
    },
  });
  const problem = sweep.error ? describeApiError(sweep.error) : undefined;

  return (
    <div className="flex flex-col items-end gap-2">
      <Button type="button" onClick={() => sweep.mutate({})} disabled={sweep.isPending}>
        <RefreshCw aria-hidden="true" className={cn(sweep.isPending && 'animate-spin')} />
        {sweep.isPending ? 'Running…' : 'Run the rules now'}
      </Button>
      {result && (
        <p role="status" className="text-muted-foreground text-xs">
          Ran {result.rulesRun.length} {result.rulesRun.length === 1 ? 'rule' : 'rules'}.{' '}
          {result.raised === 0
            ? 'No new alerts.'
            : `${result.raised} new ${result.raised === 1 ? 'alert' : 'alerts'}.`}
          {result.rulesSkipped.length > 0 && ` Skipped ${result.rulesSkipped.join(', ')}.`}
        </p>
      )}
      {problem && (
        <p role="alert" className="text-destructive text-xs">
          {problem.message}
        </p>
      )}
    </div>
  );
}

/**
 * Who has the most open questions against them, worked out from the open
 * alerts when you ask (docs/plan/08 §8). A score is a place to start
 * reading, not a finding.
 */
function HighestRisk() {
  const risk = $api.useQuery('get', '/detection/risk-scores', {
    params: { query: { limit: RISK_LIST_SIZE } },
  });

  if (risk.isError) {
    return (
      <LoadErrorAlert
        title="The risk scores could not be loaded"
        error={risk.error}
        retrying={risk.isFetching}
        onRetry={() => void risk.refetch()}
      />
    );
  }
  return (
    <Card
      role="region"
      aria-labelledby="risk-heading"
      className="stagger-1 rounded-2xl motion-safe:animate-rise-soft"
    >
      <CardHeader>
        <CardTitle id="risk-heading" className="font-heading text-lg">
          Highest risk
        </CardTitle>
        <CardDescription>
          Severity times how often a rule fired, added up over open alerts. A place to start, not a
          verdict.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {risk.isPending ? (
          <div className="grid gap-2">
            <span role="status" className="sr-only">
              Loading the risk scores…
            </span>
            <Skeleton aria-hidden="true" className="h-5 w-2/3" />
            <Skeleton aria-hidden="true" className="h-5 w-1/2" />
          </div>
        ) : risk.data.items.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Nobody has an open alert. The queue is clear.
          </p>
        ) : (
          <ol className="grid gap-2 text-sm">
            {risk.data.items.map((row) => (
              <li
                key={row.employee.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2"
              >
                <span>
                  <Link
                    to={routes.employee(row.employee.id)}
                    className="text-primary underline underline-offset-4 hover:no-underline"
                  >
                    {row.employee.fullName}
                  </Link>{' '}
                  <span className="font-mono text-muted-foreground text-xs">
                    {row.employee.staffNumber}
                  </span>
                </span>
                <span className="flex items-center gap-3 text-muted-foreground">
                  <RuleBadge code={row.topRule} />
                  <span className="tabular-nums">
                    {row.openAlerts} open · score {row.score}
                  </span>
                </span>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

interface AlertRowsProps {
  loading: boolean;
  page: DetectionAlertList | undefined;
  siteNames: Map<string, string>;
  filtered: boolean;
}

function AlertRows({ loading, page, siteNames, filtered }: AlertRowsProps) {
  if (loading) {
    return <TableLoadingRows colSpan={COLUMN_COUNT} label="Loading the alerts…" />;
  }
  if (!page || page.items.length === 0) {
    return (
      <TableEmptyRow
        colSpan={COLUMN_COUNT}
        icon={ShieldCheck}
        title={filtered ? 'Nothing matches these filters.' : 'No open alerts.'}
        hint={
          filtered
            ? 'Change a filter to see more.'
            : 'Every rule that ran found nothing to ask about.'
        }
      />
    );
  }
  return page.items.map((alert) => (
    <TableRow key={alert.id}>
      <TableCell className="pl-4 tabular-nums">{formatDateTime(alert.openedAt)}</TableCell>
      <TableCell>
        <RuleBadge code={alert.ruleCode} />
      </TableCell>
      <TableCell>
        <span className="flex flex-wrap gap-1">
          <SeverityBadge severity={alert.severity} />
          {alert.status !== 'OPEN' && <AlertStatusBadge status={alert.status} />}
        </span>
      </TableCell>
      <TableCell>
        <Subject alert={alert} />
      </TableCell>
      <TableCell className="whitespace-normal">
        {alert.subject.siteId ? (siteNames.get(alert.subject.siteId) ?? 'Site') : '—'}
      </TableCell>
      <TableCell className="pr-4 text-right">
        <Link
          to={routes.detectionAlert(alert.id)}
          className="text-primary underline underline-offset-4 hover:no-underline"
        >
          Open
        </Link>
      </TableCell>
    </TableRow>
  ));
}

/** Who or what the alert is about: a worker, a device, or only a site. */
function Subject({ alert }: { alert: DetectionAlert }) {
  const { employee, device } = alert.subject;
  if (employee) {
    return (
      <>
        {employee.fullName}{' '}
        <span className="font-mono text-muted-foreground text-xs">{employee.staffNumber}</span>
      </>
    );
  }
  if (device) {
    return (
      <>
        {device.name} <span className="text-muted-foreground text-xs">(device)</span>
      </>
    );
  }
  return <span className="text-muted-foreground">The site</span>;
}
