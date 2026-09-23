import type { AttemptOutcome, ClockInAttempt, ClockInAttemptList } from '@samtec/contracts';
import { cn } from 'cn';
import { ArrowLeft, ScanFace } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { routes } from '@/app/routes';
import { AttemptOutcomeBadge } from '@/components/biometrics-badges';
import { LoadErrorAlert } from '@/components/load-error-alert';
import { PageHeader } from '@/components/page-header';
import { PaginationNav } from '@/components/pagination-nav';
import { SelectField } from '@/components/select-field';
import { TableEmptyRow, TableLoadingRows } from '@/components/table-states';
import { Card } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { $api } from '@/lib/api';
import {
  ATTEMPT_OUTCOMES,
  attemptOutcomeLabels,
  attemptPurposeLabels,
  isAttemptOutcome,
  kioskDirectionLabels,
} from '@/lib/biometrics';
import { useCursorPages } from '@/lib/cursor-pages';
import { formatDateTime } from '@/lib/format';
import { usePageTitle } from '@/lib/page-title';

const PAGE_SIZE = 25;
const COLUMN_COUNT = 5;
/** The contract's largest page; a company has far fewer devices than that. */
const DEVICE_PAGE_SIZE = 100;
/** A UUID, the only thing the address may name. */
const ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every face and fingerprint attempt at the kiosks (ADMIN only), successes
 * and failures, newest first: a kiosk that keeps failing, or someone trying
 * face after face, shows up here. Never a score or an image.
 */
export function KioskAttemptsPage() {
  usePageTitle('Kiosk attempts');
  // The address is the source of truth for the kiosk, so a link to one kiosk
  // can be copied and refreshed. A value that is not an ID means "all kiosks".
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('deviceId') ?? '';
  const deviceId = ID_SHAPE.test(requested) ? requested : '';
  const [outcome, setOutcome] = useState<AttemptOutcome>();
  const pages = useCursorPages();

  const devices = $api.useQuery('get', '/devices', {
    params: { query: { limit: DEVICE_PAGE_SIZE } },
  });
  const kiosks = (devices.data?.items ?? []).filter((device) => device.kind === 'FACE_KIOSK');

  const attempts = $api.useQuery(
    'get',
    '/attendance/clock-in-attempts',
    {
      params: {
        query: {
          ...(deviceId !== '' && { deviceId }),
          outcome,
          limit: PAGE_SIZE,
          cursor: pages.cursor,
        },
      },
    },
    { placeholderData: (previous) => previous },
  );
  const showingOldPage = attempts.isPlaceholderData;
  const nextCursor = attempts.error ? null : (attempts.data?.nextCursor ?? null);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <Link
        to={routes.devices}
        className="flex w-fit items-center gap-1 text-muted-foreground text-sm hover:text-foreground"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        Devices
      </Link>
      <PageHeader
        eyebrow="Biometrics"
        title="Kiosk attempts"
        description="Every try at a kiosk, matched or not. A run of failures on one kiosk, or one person failing again and again, deserves a look."
      />

      <div className="flex flex-wrap items-start gap-4 rounded-2xl border bg-card/60 p-4">
        <SelectField
          id="attempts-device"
          label="Kiosk"
          value={deviceId}
          disabled={devices.isPending || devices.isError}
          onChange={(value) => {
            setSearchParams(value === '' ? {} : { deviceId: value }, { replace: true });
            pages.reset();
          }}
        >
          <option value="">{devices.isPending ? 'Loading kiosks…' : 'All kiosks'}</option>
          {kiosks.map((kiosk) => (
            <option key={kiosk.id} value={kiosk.id}>
              {kiosk.name}
            </option>
          ))}
        </SelectField>
        <SelectField
          id="attempts-outcome"
          label="Outcome"
          value={outcome ?? ''}
          onChange={(value) => {
            setOutcome(isAttemptOutcome(value) ? value : undefined);
            pages.reset();
          }}
        >
          <option value="">All outcomes</option>
          {ATTEMPT_OUTCOMES.map((value) => (
            <option key={value} value={value}>
              {attemptOutcomeLabels[value]}
            </option>
          ))}
        </SelectField>
      </div>

      {attempts.error ? (
        <LoadErrorAlert
          title="Attempts could not be loaded"
          error={attempts.error}
          retrying={attempts.isFetching}
          onRetry={() => void attempts.refetch()}
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
                <TableHead className="pl-4">When</TableHead>
                <TableHead>Kiosk</TableHead>
                <TableHead>How</TableHead>
                <TableHead>Who</TableHead>
                <TableHead className="pr-4">Outcome</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <AttemptRows
                loading={attempts.isPending}
                page={attempts.data}
                filtered={deviceId !== '' || outcome !== undefined}
              />
            </TableBody>
          </Table>
        </Card>
      )}

      <PaginationNav pages={pages} nextCursor={nextCursor} busy={showingOldPage} />
    </div>
  );
}

interface AttemptRowsProps {
  loading: boolean;
  page: ClockInAttemptList | undefined;
  filtered: boolean;
}

function AttemptRows({ loading, page, filtered }: AttemptRowsProps) {
  if (loading) {
    return <TableLoadingRows colSpan={COLUMN_COUNT} label="Loading attempts…" />;
  }
  if (!page || page.items.length === 0) {
    return (
      <TableEmptyRow
        colSpan={COLUMN_COUNT}
        icon={ScanFace}
        title={filtered ? 'Nothing matches these filters.' : 'No attempts yet.'}
        hint="Every face or fingerprint try at a kiosk is listed here, whether it matched or not."
      />
    );
  }
  return page.items.map((attempt) => <AttemptRow key={attempt.id} attempt={attempt} />);
}

function AttemptRow({ attempt }: { attempt: ClockInAttempt }) {
  return (
    <TableRow>
      <TableCell className="pl-4 tabular-nums">{formatDateTime(attempt.attemptedAt)}</TableCell>
      <TableCell>{attempt.deviceName}</TableCell>
      <TableCell>
        {attemptPurposeLabels[attempt.purpose]}
        <span className="text-muted-foreground"> · {kioskDirectionLabels[attempt.direction]}</span>
      </TableCell>
      <TableCell className="whitespace-normal">
        <AttemptWho attempt={attempt} />
      </TableCell>
      <TableCell className="pr-4">
        <AttemptOutcomeBadge outcome={attempt.outcome} />
      </TableCell>
    </TableRow>
  );
}

/** The person the kiosk matched, the number typed, and who a co-sign was for. */
function AttemptWho({ attempt }: { attempt: ClockInAttempt }) {
  return (
    <>
      {attempt.employee ? (
        <Link
          to={routes.employee(attempt.employee.id)}
          className="text-primary underline underline-offset-4 hover:no-underline"
        >
          {attempt.employee.fullName}
        </Link>
      ) : (
        <span className="text-muted-foreground">Nobody matched</span>
      )}
      {attempt.staffNumberTried && (
        <span className="text-muted-foreground">
          {' '}
          · typed <span className="font-mono">{attempt.staffNumberTried}</span>
        </span>
      )}
      {attempt.coSignFor && (
        <span className="text-muted-foreground"> · co-signed for {attempt.coSignFor.fullName}</span>
      )}
    </>
  );
}
