import type {
  EmployeeBiometrics,
  EmployeeStatus,
  RequestExemptionRequest,
} from '@samtec/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useState } from 'react';
import { ExemptionStatusBadge, FaceStatusBadge } from '@/components/biometrics-badges';
import { DetailRow } from '@/components/detail-row';
import { LoadErrorAlert } from '@/components/load-error-alert';
import { SelectField } from '@/components/select-field';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { $api } from '@/lib/api';
import {
  consentStatusLabels,
  dedupeLabels,
  EXEMPTION_REQUEST_REASONS,
  exemptionReasonLabels,
} from '@/lib/biometrics';
import { formatDateTime } from '@/lib/format';
import { describeApiError } from '@/lib/problem';
import { pageRoles, roleAllowed } from '@/lib/roles';
import { useSession } from '@/lib/session';

// The contract's rule for every reason and note.
const TEXT_MIN_LENGTH = 3;
const TEXT_MAX_LENGTH = 500;

type PanelAction = 'revoke' | 'withdraw' | 'ask' | 'decide';

/**
 * The Biometrics card on an employee's page: consent, the face, the
 * fingerprint keys and any exemption. Statuses only. An ADMIN can wipe the
 * face, record a withdrawal of consent, ask for an exemption, or decide one
 * that another ADMIN asked for. The API refuses the rest (a supervisor
 * outside the site, a guard) and the page never shows the card to them.
 */
interface BiometricsPanelProps {
  employeeId: string;
  /** The employee's status, which decides whether an exemption may be asked for. */
  employeeStatus: EmployeeStatus;
}

export function BiometricsPanel({ employeeId, employeeStatus }: BiometricsPanelProps) {
  const session = useSession();
  const mayRead = session !== null && roleAllowed(pageRoles.biometrics, session.user.role);
  const biometrics = $api.useQuery(
    'get',
    '/employees/{employeeId}/biometrics',
    { params: { path: { employeeId } } },
    { enabled: mayRead },
  );

  if (!mayRead) {
    return null;
  }

  return (
    <Card className="stagger-3 rounded-2xl motion-safe:animate-rise-soft">
      <CardHeader>
        <CardTitle className="font-heading text-lg">Biometrics</CardTitle>
        <CardDescription>
          Consent, the enrolled face and the fingerprint keys. SAMTEC keeps numbers measured from a
          face, never a photo.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {biometrics.isError ? (
          <LoadErrorAlert
            title="Biometrics could not be loaded"
            error={biometrics.error}
            retrying={biometrics.isFetching}
            onRetry={() => void biometrics.refetch()}
          />
        ) : biometrics.isPending ? (
          <div className="grid gap-2">
            <span role="status" className="sr-only">
              Loading biometrics…
            </span>
            <Skeleton aria-hidden="true" className="h-5 w-3/4" />
            <Skeleton aria-hidden="true" className="h-5 w-1/2" />
            <Skeleton aria-hidden="true" className="h-5 w-2/3" />
          </div>
        ) : (
          <>
            <BiometricsStatus record={biometrics.data} />
            {roleAllowed(pageRoles.biometricChanges, session.user.role) && (
              <BiometricsActions
                record={biometrics.data}
                employeeStatus={employeeStatus}
                currentUserId={session.user.id}
              />
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function BiometricsStatus({ record }: { record: EmployeeBiometrics }) {
  const activeKeys = record.passkeys.filter((key) => key.revokedAt === null);
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
      <DetailRow term="Consent">
        {consentStatusLabels[record.consent.status]}
        {record.consent.at && (
          <span className="text-muted-foreground tabular-nums">
            {' '}
            · {formatDateTime(record.consent.at)}
            {record.consent.textVersion && ` (${record.consent.textVersion})`}
          </span>
        )}
      </DetailRow>
      <DetailRow term="Face">
        <span className="flex flex-wrap items-center gap-2">
          <FaceStatusBadge status={record.face.status} />
          {record.face.dedupe && (
            <span className="text-muted-foreground">{dedupeLabels[record.face.dedupe]}</span>
          )}
        </span>
        {record.face.enrolledAt && (
          <span className="mt-1 block text-muted-foreground tabular-nums">
            Enrolled {formatDateTime(record.face.enrolledAt)}
            {record.face.deviceName && ` on ${record.face.deviceName}`}
          </span>
        )}
      </DetailRow>
      <DetailRow term="Fingerprint keys">
        {record.passkeys.length === 0 ? (
          <span className="text-muted-foreground">None</span>
        ) : (
          <ul className="grid gap-1">
            {record.passkeys.map((key) => (
              <li key={key.id} className={key.revokedAt ? 'text-muted-foreground' : undefined}>
                {key.deviceName}
                <span className="text-muted-foreground tabular-nums">
                  {' '}
                  · {key.revokedAt ? `switched off ${formatDateTime(key.revokedAt)}` : 'in use'}
                  {key.synced && ' · may be copied to a cloud account'}
                </span>
              </li>
            ))}
          </ul>
        )}
        {activeKeys.length === 0 && record.passkeys.length > 0 && (
          <span className="sr-only">No key is in use.</span>
        )}
      </DetailRow>
      <DetailRow term="Exemption">
        {record.exemption ? (
          <>
            <span className="flex flex-wrap items-center gap-2">
              <ExemptionStatusBadge status={record.exemption.status} />
              <span className="text-muted-foreground">
                {exemptionReasonLabels[record.exemption.reason]}
              </span>
            </span>
            {record.exemption.note && <span className="mt-1 block">{record.exemption.note}</span>}
            <span className="mt-1 block text-muted-foreground tabular-nums">
              Asked {formatDateTime(record.exemption.requestedAt)}
              {record.exemption.reviewedAt &&
                `, decided ${formatDateTime(record.exemption.reviewedAt)}`}
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">None</span>
        )}
      </DetailRow>
    </dl>
  );
}

interface BiometricsActionsProps {
  record: EmployeeBiometrics;
  employeeStatus: EmployeeStatus;
  currentUserId: string;
}

/**
 * What an ADMIN may do next. Each button opens one small form with the
 * reason the audit log keeps. The rules mirror the API's: it still has the
 * final say, and its refusal is shown word for word.
 */
function BiometricsActions({ record, employeeStatus, currentUserId }: BiometricsActionsProps) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState<PanelAction | null>(null);
  const [text, setText] = useState('');
  const [reason, setReason] = useState<RequestExemptionRequest['reason']>('DECLINED');
  const [decision, setDecision] = useState<'APPROVE' | 'REJECT'>('APPROVE');
  const [mistake, setMistake] = useState<string | null>(null);

  function done() {
    setOpen(null);
    setText('');
    // The status changed, and the real API may also have changed the employee's status.
    void queryClient.invalidateQueries({ queryKey: ['get', '/employees/{employeeId}/biometrics'] });
    void queryClient.invalidateQueries({ queryKey: ['get', '/employees/{employeeId}'] });
    void queryClient.invalidateQueries({ queryKey: ['get', '/employees'] });
  }

  const revoke = $api.useMutation('post', '/employees/{employeeId}/biometrics/revoke', {
    onSuccess: done,
  });
  const withdraw = $api.useMutation('post', '/employees/{employeeId}/biometric-consents/withdraw', {
    onSuccess: done,
  });
  const ask = $api.useMutation('post', '/employees/{employeeId}/biometric-exemption', {
    onSuccess: done,
  });
  const decide = $api.useMutation('post', '/employees/{employeeId}/biometric-exemption/review', {
    onSuccess: done,
  });
  const mutations = { revoke, withdraw, ask, decide };
  const pending = Object.values(mutations).some((mutation) => mutation.isPending);
  const failed = Object.values(mutations).find((mutation) => mutation.error);
  const problem = failed?.error ? describeApiError(failed.error) : undefined;

  const pathParams = { params: { path: { employeeId: record.employeeId } } };
  const exemption = record.exemption;
  const waiting = exemption?.status === 'REQUESTED';
  const askedByMe = waiting && exemption.requestedByUserId === currentUserId;
  const hasFace = record.face.status === 'PENDING' || record.face.status === 'ACTIVE';
  const hasKeys = record.passkeys.some((key) => key.revokedAt === null);
  const blocked = record.face.status === 'BLOCKED';
  // A PENDING face is an open duplicate review: a second ADMIN decides it first.
  const underReview = record.face.status === 'PENDING';
  const canRevoke = (hasFace || hasKeys) && !blocked && !waiting && !underReview;
  const canWithdraw = record.consent.status === 'GIVEN';
  // The contract allows a request only for a worker still waiting for enrollment.
  const canAsk =
    employeeStatus === 'PENDING_ENROLLMENT' &&
    !hasFace &&
    !blocked &&
    !waiting &&
    exemption?.status !== 'APPROVED';

  function start(action: PanelAction) {
    if (pending) return;
    for (const mutation of Object.values(mutations)) mutation.reset();
    setMistake(null);
    setText('');
    setOpen(action);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || open === null) return;
    const trimmed = text.trim();
    if (trimmed.length < TEXT_MIN_LENGTH || trimmed.length > TEXT_MAX_LENGTH) {
      setMistake(`Explain in ${TEXT_MIN_LENGTH} to ${TEXT_MAX_LENGTH} characters.`);
      return;
    }
    setMistake(null);
    switch (open) {
      case 'revoke':
        revoke.mutate({ ...pathParams, body: { reason: trimmed } });
        return;
      case 'withdraw':
        withdraw.mutate({ ...pathParams, body: { reason: trimmed } });
        return;
      case 'ask':
        ask.mutate({ ...pathParams, body: { reason, note: trimmed } });
        return;
      case 'decide':
        decide.mutate({ ...pathParams, body: { decision, note: trimmed } });
        return;
      default:
        open satisfies never;
    }
  }

  return (
    <div className="grid gap-3 border-t pt-4">
      {askedByMe && (
        <p className="text-muted-foreground text-sm">
          You asked for this exemption, so another administrator must decide it after checking the
          worker's Ghana Card in person.
        </p>
      )}
      {blocked && (
        <p className="text-muted-foreground text-sm">
          This record was found to be a duplicate of another person's. It can only be terminated.
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {waiting && !askedByMe && (
          <Button variant="outline" onClick={() => start('decide')} aria-disabled={pending}>
            Decide the exemption
          </Button>
        )}
        {canAsk && (
          <Button variant="outline" onClick={() => start('ask')} aria-disabled={pending}>
            Ask for an exemption
          </Button>
        )}
        {canRevoke && (
          <Button variant="outline" onClick={() => start('revoke')} aria-disabled={pending}>
            Wipe the face and keys
          </Button>
        )}
        {canWithdraw && (
          <Button variant="outline" onClick={() => start('withdraw')} aria-disabled={pending}>
            Record a withdrawal of consent
          </Button>
        )}
      </div>

      {open && (
        <form noValidate onSubmit={submit} aria-busy={pending} className="grid gap-3">
          <p className="text-sm">{formIntro[open]}</p>
          {open === 'ask' && (
            <SelectField
              id="exemption-reason"
              label="Reason"
              value={reason}
              onChange={(value) => {
                const chosen = EXEMPTION_REQUEST_REASONS.find((option) => option === value);
                if (chosen) setReason(chosen);
              }}
            >
              {EXEMPTION_REQUEST_REASONS.map((value) => (
                <option key={value} value={value}>
                  {exemptionReasonLabels[value]}
                </option>
              ))}
            </SelectField>
          )}
          {open === 'decide' && (
            <fieldset className="grid gap-2">
              <legend className="mb-1 font-medium text-sm">Your decision</legend>
              {(['APPROVE', 'REJECT'] as const).map((value) => (
                <label key={value} className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="exemption-decision"
                    value={value}
                    checked={decision === value}
                    onChange={() => setDecision(value)}
                  />
                  {value === 'APPROVE'
                    ? 'Approve: the worker clocks in by a supervisor’s co-sign'
                    : 'Reject: the worker stays waiting for enrollment'}
                </label>
              ))}
            </fieldset>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="biometrics-note">
              {open === 'ask' || open === 'decide' ? 'Note' : 'Reason'}
            </Label>
            <Textarea
              id="biometrics-note"
              value={text}
              minLength={TEXT_MIN_LENGTH}
              maxLength={TEXT_MAX_LENGTH}
              rows={3}
              onChange={(event) => setText(event.target.value)}
              aria-describedby="biometrics-note-hint"
              aria-invalid={mistake !== null || undefined}
            />
            <p id="biometrics-note-hint" className="text-muted-foreground text-xs">
              Kept in the audit log under your name. Facts only: never religion or health details.
            </p>
          </div>
          {mistake && (
            <Alert variant="destructive">
              <AlertDescription>{mistake}</AlertDescription>
            </Alert>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit">{pending ? 'Saving…' : submitLabels[open]}</Button>
            <Button type="button" variant="ghost" onClick={() => setOpen(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {problem && (
        <Alert variant="destructive">
          <AlertTitle>That did not work</AlertTitle>
          <AlertDescription>
            <p>{problem.message}</p>
            {problem.traceId && <p className="font-mono text-xs">Trace ID: {problem.traceId}</p>}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}

const formIntro: Record<PanelAction, string> = {
  revoke:
    'The stored face is wiped at once and every fingerprint key is switched off. The worker must be enrolled again, and any approved exemption ends.',
  withdraw:
    'The face is wiped and the keys are switched off, as the law requires. If the worker was active, the API files an exemption request for a different administrator to decide.',
  ask: 'This only asks. A second administrator checks the worker’s Ghana Card in person and approves or rejects it. Until then, consent and enrollment are refused.',
  decide:
    'Check the worker’s Ghana Card in person first. Approving lets them work without biometrics; every shift is then flagged for review.',
};

const submitLabels: Record<PanelAction, string> = {
  revoke: 'Confirm the wipe',
  withdraw: 'Record the withdrawal',
  ask: 'Send the request',
  decide: 'Record the decision',
};
