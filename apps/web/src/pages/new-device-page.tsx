import type { DeviceKind, DeviceWithSecret } from '@samtec/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { type FormEvent, useState } from 'react';
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
import { DEVICE_KINDS, deviceKindLabels, isDeviceKind } from '@/lib/attendance';
import { usePageTitle } from '@/lib/page-title';
import { describeApiError } from '@/lib/problem';

// The contract's limits (`RegisterDeviceRequest`).
const NAME_MIN_LENGTH = 2;
const NAME_MAX_LENGTH = 60;

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
  const [kind, setKind] = useState<DeviceKind>('ZKTECO');
  const [mistake, setMistake] = useState<string | null>(null);
  const [registered, setRegistered] = useState<DeviceWithSecret | null>(null);

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
    register.mutate({ body: { name: trimmed, siteId, kind } });
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
              <SecretPanel
                secret={registered.secret}
                explanation="Put this secret into the device or its gateway; it signs every request the device sends. It does nothing until another administrator switches the device on."
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
