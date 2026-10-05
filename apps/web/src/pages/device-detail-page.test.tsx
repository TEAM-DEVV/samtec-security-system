import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse, http } from 'msw';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { routes } from '@/app/routes';
import { fetchClient } from '@/lib/api';
import { env } from '@/lib/env';
import { mockDevices } from '@/mocks/data/devices';
import { server } from '@/mocks/node';
import { renderWithProviders } from '@/test/render';
import { signInForTests } from '@/test/session';
import { DeviceDetailPage } from './device-detail-page';

const TERMINAL_ID = mockDevices[0]?.id ?? '';
const KIOSK_ID = mockDevices.find((device) => device.kind === 'FACE_KIOSK')?.id ?? '';

function renderDevicePage(deviceId: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/devices/:deviceId" element={<DeviceDetailPage />} />
      <Route path={routes.devices} element={<p>Device list</p>} />
    </Routes>,
    { route: routes.device(deviceId) },
  );
}

describe('DeviceDetailPage', () => {
  it("links the device's site to the site's own page", async () => {
    await signInForTests('admin@samtec.example');
    renderDevicePage(TERMINAL_ID);
    await screen.findByRole('heading', { name: 'Mock terminal ACC-01' });

    // The site's name comes from a second, independent query, so it may not
    // have resolved yet even once the heading (from the device query) has.
    const siteLink = await screen.findByRole('link', { name: /ACC-01/ });
    expect(siteLink).toHaveAttribute('href', routes.site('01927c3e-1111-7aaa-8bbb-0c0c0c0c0c01'));
  });

  it('renames a device and reports it', async () => {
    await signInForTests('admin@samtec.example');
    const user = userEvent.setup();
    renderDevicePage(TERMINAL_ID);
    await screen.findByRole('heading', { name: 'Mock terminal ACC-01' });

    const name = screen.getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Ridge Towers main gate');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(
      await screen.findByRole('heading', { name: 'Ridge Towers main gate' }),
    ).toBeInTheDocument();
  });

  it('switches a device off after asking, then offers to switch it on', async () => {
    await signInForTests('admin@samtec.example');
    const user = userEvent.setup();
    renderDevicePage(TERMINAL_ID);
    await screen.findByRole('heading', { name: 'Mock terminal ACC-01' });

    await user.click(screen.getByRole('button', { name: 'Switch off' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Switch off' }));

    expect(await screen.findByRole('button', { name: 'Switch on' })).toBeInTheDocument();
    expect(screen.getByText('Switched off')).toBeInTheDocument();
  });

  it('rotates the secret after asking, shows it once, and forgets it when the page closes', async () => {
    await signInForTests('admin@samtec.example');
    const user = userEvent.setup();
    const { queryClient, unmount } = renderDevicePage(TERMINAL_ID);
    await screen.findByRole('heading', { name: 'Mock terminal ACC-01' });

    await user.click(screen.getByRole('button', { name: 'New secret' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Rotate the secret' }));

    const secret = await screen.findByLabelText<HTMLInputElement>('Secret');
    expect(secret.value.length).toBeGreaterThan(20);

    unmount();
    await waitFor(() => expect(queryClient.getMutationCache().getAll()).toEqual([]));
  });

  it('lets the administrator who registered a device switch it on', async () => {
    await signInForTests('admin@samtec.example');
    const user = userEvent.setup();
    const made = await fetchClient.POST('/devices', {
      body: {
        name: 'Gate house kiosk',
        siteId: '01927c3e-1111-7aaa-8bbb-0c0c0c0c0c01',
        kind: 'MOCK',
      },
    });
    const deviceId = made.data?.device.id ?? '';
    renderDevicePage(deviceId);
    await screen.findByRole('heading', { name: 'Gate house kiosk' });

    // It arrives switched off; the same administrator switches it on.
    await user.click(screen.getByRole('button', { name: 'Switch on' }));

    expect(await screen.findByRole('button', { name: 'Switch off' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Switch on' })).not.toBeInTheDocument();
  });
  it('offers the fingerprint switch only on a kiosk', async () => {
    await signInForTests('admin@samtec.example');
    renderDevicePage(KIOSK_ID);
    await screen.findByRole('heading', { name: /Kiosk/ });

    expect(screen.getByRole('checkbox')).toBeChecked();
    expect(screen.queryByLabelText('Serial number')).not.toBeInTheDocument();
  });

  it('shows the API error with a way to try again', async () => {
    await signInForTests('admin@samtec.example');
    server.use(
      http.get(`${env.apiBaseUrl}/devices/:deviceId`, () =>
        HttpResponse.json(
          {
            type: 'about:blank',
            title: 'Internal Server Error',
            status: 500,
            detail: 'The database is not available.',
            traceId: 'trace-test-500',
          },
          { status: 500 },
        ),
      ),
    );

    renderDevicePage(TERMINAL_ID);

    expect(await screen.findByText('The device could not be loaded')).toBeInTheDocument();
    expect(screen.getByText('The database is not available.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
