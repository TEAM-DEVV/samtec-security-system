import type { Device, UpdateDeviceRequest } from '@samtec/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { Link, useParams } from 'react-router';
import { routes } from '@/app/routes';
import { DeviceStatusBadge } from '@/components/attendance-badges';
import { DetailRow } from '@/components/detail-row';
import { LoadErrorAlert } from '@/components/load-error-alert';
import { SecretPanel } from '@/components/secret-panel';
import { useSiteNames } from '@/components/site-select';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { $api } from '@/lib/api';
import { describeDrift, deviceKindLabels, driftIsSuspect } from '@/lib/attendance';
import { formatDateTime } from '@/lib/format';
import { usePageTitle } from '@/lib/page-title';
import { describeApiError, isProblemDetails } from '@/lib/problem';

const NAME_MIN_LENGTH = 2;
const NAME_MAX_LENGTH = 60;
const SERIAL_SHAPE = /^[A-Za-z0-9-]{1,64}$/;

/**
 * One clock-in device (ADMIN only): rename it, set a ZKTeco serial number,
 * switch a kiosk's fingerprint sensor on or off, switch the device off or
 * on, or give it a new secret.
 */
export function DeviceDetailPage() {
  const { deviceId = '' } = useParams<{ deviceId: string }>();
  usePageTitle('Device');
  const device = $api.useQuery('get', '/devices/{deviceId}', { params: { path: { deviceId } } });

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <Link
        to={routes.devices}
        className="flex w-fit items-center gap-1 text-muted-foreground text-sm hover:text-foreground"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        Devices
      </Link>

      {device.isError ? (
        <LoadError
          error={device.error}
          retrying={device.isFetching}
          onRetry={() => void device.refetch()}
        />
      ) : device.isPending ? (
        <LoadingDevice />
      ) : (
        <DeviceRecord device={device.data} />
      )}
    </div>
  );
}

function DeviceRecord({ device }: { device: Device }) {
  const queryClient = useQueryClient();
  const siteNames = useSiteNames();
  const [newSecret, setNewSecret] = useState<string | null>(null);

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ['get', '/devices/{deviceId}'] });
    void queryClient.invalidateQueries({ queryKey: ['get', '/devices'] });
  }

  const update = $api.useMutation('patch', '/devices/{deviceId}', { onSuccess: refresh });
  const rotate = $api.useMutation('post', '/devices/{deviceId}/rotate-secret', {
    // The response holds the secret: forget it the moment this page closes.
    gcTime: 0,
    onSuccess: (result) => {
      setNewSecret(result.secret);
      refresh();
    },
  });

  const pathParams = { params: { path: { deviceId: device.id } } };
  const switchedOff = device.status === 'INACTIVE';
  const suspect = driftIsSuspect(device.lastClockDriftSeconds);

  function setStatus(status: Device['status']) {
    update.reset();
    rotate.reset();
    update.mutate({ ...pathParams, body: { status } });
  }

  const actionError = update.error ?? rotate.error;
  const actionProblem = actionError ? describeApiError(actionError) : undefined;

  return (
    <>
      <header className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border bg-card/60 p-5 motion-safe:animate-rise-soft">
        <div className="space-y-1">
          <h1 className="font-semibold text-3xl tracking-tight">{device.name}</h1>
          <p className="text-muted-foreground text-sm">
            {deviceKindLabels[device.kind]} · {siteNames.get(device.siteId) ?? 'Site'}
          </p>
        </div>
        <DeviceStatusBadge status={device.status} />
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="stagger-1 rounded-2xl motion-safe:animate-rise-soft">
          <CardHeader>
            <CardTitle className="font-heading text-lg">Settings</CardTitle>
            <CardDescription>
              A device stays at its site for life; register it again to move it.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <DeviceSettingsForm
              key={device.updatedAt}
              device={device}
              pending={update.isPending}
              error={update.error}
              onSubmit={(body) => {
                rotate.reset();
                update.mutate({ ...pathParams, body });
              }}
            />
          </CardContent>
        </Card>

        <Card className="stagger-2 rounded-2xl motion-safe:animate-rise-soft">
          <CardHeader>
            <CardTitle className="font-heading text-lg">Health</CardTitle>
            <CardDescription>What the device's signed requests tell us.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
              <DetailRow term="Last seen">
                {device.lastSeenAt ? (
                  <span className="tabular-nums">{formatDateTime(device.lastSeenAt)}</span>
                ) : (
                  <span className="text-muted-foreground">Never</span>
                )}
              </DetailRow>
              <DetailRow term="Clock">
                <span
                  className={suspect ? 'font-medium text-amber-800 dark:text-amber-300' : undefined}
                >
                  {describeDrift(device.lastClockDriftSeconds)}
                  {suspect && ' · its punch times are suspect'}
                </span>
              </DetailRow>
              <DetailRow term="Bad signatures">
                <span
                  className={
                    device.failedSignatureCount > 0
                      ? 'font-medium text-red-700 dark:text-red-300'
                      : undefined
                  }
                >
                  {device.failedSignatureCount}
                  {device.lastFailedSignatureAt &&
                    `, last ${formatDateTime(device.lastFailedSignatureAt)}`}
                </span>
              </DetailRow>
              <DetailRow term="Registered">
                <span className="tabular-nums">{formatDateTime(device.createdAt)}</span>
              </DetailRow>
            </dl>

            {newSecret && (
              <SecretPanel
                secret={newSecret}
                explanation="The old secret stopped working at once. Put this one into the device or its gateway; it will resend any batch that was not acknowledged."
              />
            )}

            <div className="flex flex-wrap gap-2">
              {device.kind === 'FACE_KIOSK' && (
                <Button asChild variant="outline">
                  <Link to={routes.kioskAttempts(device.id)}>Attempts on this kiosk</Link>
                </Button>
              )}
              {switchedOff ? (
                <Button
                  variant="outline"
                  aria-disabled={update.isPending}
                  onClick={() => {
                    if (!update.isPending) setStatus('ACTIVE');
                  }}
                >
                  {update.isPending ? 'Switching on…' : 'Switch on'}
                </Button>
              ) : (
                <ConfirmButton
                  label={update.isPending ? 'Switching off…' : 'Switch off'}
                  title={`Switch off ${device.name}?`}
                  description="Every request it sends is refused from now on. Nothing is deleted; you can switch it back on later."
                  confirmLabel="Switch off"
                  pending={update.isPending || rotate.isPending}
                  onConfirm={() => setStatus('INACTIVE')}
                />
              )}
              <ConfirmButton
                label={rotate.isPending ? 'Rotating…' : 'New secret'}
                title={`Give ${device.name} a new secret?`}
                description="The old secret stops working at once, with no overlap. The device keeps any batch it could not deliver and resends it once it has the new secret."
                confirmLabel="Rotate the secret"
                pending={update.isPending || rotate.isPending}
                onConfirm={() => {
                  update.reset();
                  rotate.mutate(pathParams);
                }}
              />
            </div>

            {actionProblem && (
              <Alert variant="destructive">
                <AlertTitle>That did not work</AlertTitle>
                <AlertDescription>
                  <p>{actionProblem.message}</p>
                  {actionProblem.traceId && (
                    <p className="font-mono text-xs">Trace ID: {actionProblem.traceId}</p>
                  )}
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

interface DeviceSettingsFormProps {
  device: Device;
  pending: boolean;
  error: unknown;
  onSubmit: (body: UpdateDeviceRequest) => void;
}

/** Name, serial number (ZKTeco only) and fingerprint sensor (kiosk only). Sends only what changed. */
function DeviceSettingsForm({ device, pending, error, onSubmit }: DeviceSettingsFormProps) {
  const [name, setName] = useState(device.name);
  const [serialNumber, setSerialNumber] = useState(device.serialNumber ?? '');
  const [passkeysEnabled, setPasskeysEnabled] = useState(device.passkeysEnabled);
  const [mistake, setMistake] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<'saved' | 'nothing-to-save' | null>(null);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) {
      return;
    }
    const trimmedName = name.trim();
    const trimmedSerial = serialNumber.trim();
    if (trimmedName.length < NAME_MIN_LENGTH) {
      setMistake(`The name needs at least ${NAME_MIN_LENGTH} characters.`);
      return;
    }
    if (trimmedSerial !== '' && !SERIAL_SHAPE.test(trimmedSerial)) {
      setMistake('A serial number is 1 to 64 letters, digits and dashes.');
      return;
    }
    setMistake(null);
    const body: UpdateDeviceRequest = {};
    if (trimmedName !== device.name) body.name = trimmedName;
    const serial = trimmedSerial === '' ? null : trimmedSerial;
    if (device.kind === 'ZKTECO' && serial !== device.serialNumber) body.serialNumber = serial;
    if (device.kind === 'FACE_KIOSK' && passkeysEnabled !== device.passkeysEnabled) {
      body.passkeysEnabled = passkeysEnabled;
    }
    if (Object.keys(body).length === 0) {
      setOutcome('nothing-to-save');
      return;
    }
    setOutcome('saved');
    onSubmit(body);
  }

  const problem = error ? describeApiError(error) : undefined;

  return (
    <form noValidate onSubmit={submit} aria-busy={pending} className="grid gap-4">
      <div className="grid gap-1.5">
        <Label htmlFor="device-name">Name</Label>
        <Input
          id="device-name"
          required
          minLength={NAME_MIN_LENGTH}
          maxLength={NAME_MAX_LENGTH}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>

      {device.kind === 'ZKTECO' && (
        <div className="grid gap-1.5">
          <Label htmlFor="device-serial">Serial number</Label>
          <Input
            id="device-serial"
            value={serialNumber}
            placeholder="From the terminal's label"
            onChange={(event) => setSerialNumber(event.target.value)}
            aria-describedby="device-serial-hint"
          />
          <p id="device-serial-hint" className="text-muted-foreground text-xs">
            The gateway accepts only terminals whose serial is listed here.
          </p>
        </div>
      )}

      {device.kind === 'FACE_KIOSK' && (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={passkeysEnabled}
            onChange={(event) => setPasskeysEnabled(event.target.checked)}
            className="mt-1"
          />
          <span>
            Workers may save a fingerprint on this kiosk's own sensor.
            <span className="block text-muted-foreground text-xs">
              Switching it off revokes every fingerprint saved on the device.
            </span>
          </span>
        </label>
      )}

      {mistake && (
        <Alert variant="destructive">
          <AlertDescription>{mistake}</AlertDescription>
        </Alert>
      )}
      {problem && (
        <Alert variant="destructive">
          <AlertTitle>Could not save the device</AlertTitle>
          <AlertDescription>
            <p>{problem.message}</p>
            {problem.traceId && <p className="font-mono text-xs">Trace ID: {problem.traceId}</p>}
          </AlertDescription>
        </Alert>
      )}

      <div className="flex items-center gap-3">
        <Button type="submit">{pending ? 'Saving…' : 'Save changes'}</Button>
        {outcome && !pending && !error && (
          <p role="status" className="text-emerald-700 text-sm dark:text-emerald-400">
            {outcome === 'saved' ? 'Saved.' : 'Nothing to save.'}
          </p>
        )}
      </div>
    </form>
  );
}

interface ConfirmButtonProps {
  label: string;
  title: string;
  description: string;
  confirmLabel: string;
  pending: boolean;
  onConfirm: () => void;
}

function ConfirmButton({
  label,
  title,
  description,
  confirmLabel,
  pending,
  onConfirm,
}: ConfirmButtonProps) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" aria-disabled={pending}>
          {label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              if (!pending) onConfirm();
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function LoadingDevice() {
  return (
    <div className="grid gap-4">
      <span role="status" className="sr-only">
        Loading the device…
      </span>
      <Skeleton aria-hidden="true" className="h-24 w-full" />
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton aria-hidden="true" className="h-64 w-full" />
        <Skeleton aria-hidden="true" className="h-64 w-full" />
      </div>
    </div>
  );
}

interface LoadErrorProps {
  error: unknown;
  retrying: boolean;
  onRetry: () => void;
}

function LoadError({ error, retrying, onRetry }: LoadErrorProps) {
  if (isProblemDetails(error) && error.status === 404) {
    return (
      <Alert>
        <AlertTitle>No device found</AlertTitle>
        <AlertDescription>
          <p>There is no device with this ID.</p>
          <p className="font-mono text-xs">Trace ID: {error.traceId}</p>
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <LoadErrorAlert
      title="The device could not be loaded"
      error={error}
      retrying={retrying}
      onRetry={onRetry}
    />
  );
}
