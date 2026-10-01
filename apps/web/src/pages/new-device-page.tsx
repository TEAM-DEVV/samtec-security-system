import type { DeviceKind, DeviceWithSecret } from '@samtec/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Check, Copy } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import { routes } from '@/app/routes';
import { PageHeader } from '@/components/page-header';
import { SecretPanel } from '@/components/secret-panel';
import { SelectField } from '@/components/select-field';
import { SiteSelect } from '@/components/site-select';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { $api } from '@/lib/api';
import { DEVICE_KINDS, deviceKindHelp, deviceKindLabels, isDeviceKind } from '@/lib/attendance';
import { usePageTitle } from '@/lib/page-title';
import { describeApiError } from '@/lib/problem';

// The contract's limits (`RegisterDeviceRequest`).
const NAME_MIN_LENGTH = 2;
const NAME_MAX_LENGTH = 60;

type CopyState = 'idle' | 'copied' | 'failed';

/** Copies plain text (not a secret) to the clipboard, for the Copy buttons below. */
async function copyText(value: string, setState: (state: CopyState) => void) {
  try {
    await navigator.clipboard.writeText(value);
    setState('copied');
  } catch {
    setState('failed');
  }
}

/**
 * Registers a clock-in device (ADMIN only). The API answers with the
 * device's signing secret, shown only in that one response, so this page
 * shows it straight away instead of moving on.
 */
export function NewDevicePage() {
  usePageTitle('Register device');
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const [siteId, setSiteId] = useState('');
  const [kind, setKind] = useState<DeviceKind>('FACE_KIOSK');
  // On by default for a Face kiosk, the common case when testing on a phone.
  const [passkeysEnabled, setPasskeysEnabled] = useState(true);
  const [mistake, setMistake] = useState<string | null>(null);
  const [registered, setRegistered] = useState<DeviceWithSecret | null>(null);
  const [idCopyState, setIdCopyState] = useState<CopyState>('idle');

  const register = $api.useMutation('post', '/devices', {
    // The response holds the secret: forget it the moment this page closes.
    gcTime: 0,
    onSuccess: (result) => {
      setRegistered(result);
      void queryClient.invalidateQueries({ queryKey: ['get', '/devices'] });
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (register.isPending) {
      return;
    }
    const trimmed = name.trim();
    if (trimmed.length < NAME_MIN_LENGTH) {
      setMistake(`The name needs at least ${NAME_MIN_LENGTH} characters.`);
      return;
    }
    if (siteId === '') {
      setMistake('Choose the site the device is installed at.');
      return;
    }
    setMistake(null);
    register.mutate({
      body: {
        name: trimmed,
        siteId,
        kind,
        ...(kind === 'FACE_KIOSK' ? { passkeysEnabled } : {}),
      },
    });
  }

  const problem = register.error ? describeApiError(register.error) : undefined;

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <Link
        to={routes.devices}
        className="flex w-fit items-center gap-1 text-muted-foreground text-sm hover:text-foreground"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        Devices
      </Link>

      {registered ? (
        <>
          <PageHeader eyebrow="Attendance" title="Device registered" />
          <Card className="rounded-2xl motion-safe:animate-rise-soft">
            <CardHeader>
              <CardTitle className="font-heading text-lg">{registered.device.name}</CardTitle>
              <CardDescription>{deviceKindLabels[registered.device.kind]}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <ol className="grid gap-3 rounded-xl border bg-muted/30 p-4 text-sm">
                <RegisterStep step={1} title="Register" done>
                  Done — here are the device's ID and secret, below.
                </RegisterStep>
                <RegisterStep step={2} title="Set up the kiosk">
                  Type them in on the phone.
                </RegisterStep>
                <RegisterStep step={3} title="Switch it on">
                  On the dashboard, on{' '}
                  <Link
                    to={routes.device(registered.device.id)}
                    className="underline underline-offset-2 hover:text-foreground"
                  >
                    this device's page
                  </Link>
                  .
                </RegisterStep>
              </ol>

              {/* A kiosk needs both halves to pair, and the ID used to appear
                  only in the address bar — so setting one up meant copying a
                  UUID out of the browser's URL. It is not a secret; it is shown
                  plainly, beside the secret that is. */}
              <div className="grid gap-1.5">
                <Label htmlFor="device-id">Device ID</Label>
                <div className="flex gap-2">
                  <Input
                    id="device-id"
                    readOnly
                    value={registered.device.id}
                    onFocus={(event) => event.currentTarget.select()}
                    className="font-mono text-xs"
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => void copyText(registered.device.id, setIdCopyState)}
                  >
                    {idCopyState === 'copied' ? (
                      <Check aria-hidden="true" />
                    ) : (
                      <Copy aria-hidden="true" />
                    )}
                    {idCopyState === 'copied' ? 'Copied' : 'Copy'}
                  </Button>
                </div>
                <p role="status" className="text-muted-foreground text-xs">
                  {idCopyState === 'failed'
                    ? 'Copying did not work here. Tap the box, select it all and copy it yourself.'
                    : 'A kiosk asks for this and the secret below. Not secret on its own.'}
                </p>
              </div>

              <SecretPanel
                secret={registered.secret}
                explanation="Put this secret into the device or its gateway; it signs every request the device sends. It does nothing until the device is switched on, on its own page."
              />
              <div className="flex flex-wrap gap-2">
                <Button asChild>
                  <Link to={routes.device(registered.device.id)}>Open the device</Link>
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    register.reset();
                    setRegistered(null);
                    setName('');
                    setIdCopyState('idle');
                  }}
                >
                  Register another
                </Button>
              </div>
            </CardContent>
          </Card>
        </>
      ) : (
        <>
          <PageHeader
            eyebrow="Attendance"
            title="Register device"
            description="A device belongs to one site for life. To move a terminal, register it again."
          />
          <Card className="rounded-2xl motion-safe:animate-rise-soft">
            <CardContent>
              <form
                noValidate
                onSubmit={submit}
                aria-busy={register.isPending}
                className="grid gap-4"
              >
                <div className="grid gap-1.5">
                  <Label htmlFor="device-name">Name</Label>
                  <Input
                    id="device-name"
                    required
                    minLength={NAME_MIN_LENGTH}
                    maxLength={NAME_MAX_LENGTH}
                    placeholder="Ridge Towers main gate"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                </div>
                <SiteSelect
                  id="device-site"
                  label="Site"
                  value={siteId}
                  emptyLabel="Choose a site"
                  onChange={setSiteId}
                />
                <SelectField
                  id="device-kind"
                  label="Kind"
                  value={kind}
                  describedBy="device-kind-help"
                  onChange={(value) => {
                    if (isDeviceKind(value)) setKind(value);
                  }}
                >
                  {/* The simulator is for development and TEST; a real gate never uses it. */}
                  {DEVICE_KINDS.filter((value) => value !== 'MOCK').map((value) => (
                    <option key={value} value={value}>
                      {deviceKindLabels[value]}
                    </option>
                  ))}
                </SelectField>
                <p id="device-kind-help" className="text-sm text-muted-foreground">
                  {deviceKindHelp[kind]} The kind cannot be changed later: if it is wrong, register
                  the device again.
                </p>

                {kind === 'FACE_KIOSK' && (
                  <label className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={passkeysEnabled}
                      onChange={(event) => setPasskeysEnabled(event.target.checked)}
                      className="mt-1"
                    />
                    <span>Allow fingerprints on this kiosk's own sensor</span>
                  </label>
                )}

                {mistake && (
                  <Alert variant="destructive">
                    <AlertDescription>{mistake}</AlertDescription>
                  </Alert>
                )}
                {problem && (
                  <Alert variant="destructive">
                    <AlertTitle>Could not register the device</AlertTitle>
                    <AlertDescription>
                      <p>{problem.message}</p>
                      {problem.traceId && (
                        <p className="font-mono text-xs">Trace ID: {problem.traceId}</p>
                      )}
                    </AlertDescription>
                  </Alert>
                )}

                <div>
                  <Button type="submit">
                    {register.isPending ? 'Registering…' : 'Register device'}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

interface RegisterStepProps {
  step: number;
  title: string;
  /** True once this step is already done, shown with a tick instead of its number. */
  done?: boolean;
  children: ReactNode;
}

/** One row of the "what happens next" list shown after a device is registered. */
function RegisterStep({ step, title, done, children }: RegisterStepProps) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden="true"
        className={`flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium ${
          done ? 'bg-emerald-600 text-white' : 'bg-muted-foreground/20 text-muted-foreground'
        }`}
      >
        {done ? <Check className="size-3.5" /> : step}
      </span>
      <div>
        <p className="font-medium">{title}</p>
        <p className="text-muted-foreground">{children}</p>
      </div>
    </li>
  );
}
