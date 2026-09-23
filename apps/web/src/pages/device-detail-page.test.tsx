import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { routes } from '@/app/routes';
import { mockDevices } from '@/mocks/data/devices';
import { renderWithProviders } from '@/test/render';
import { signInForTests } from '@/test/session';
import { DeviceDetailPage } from './device-detail-page';
import { NewDevicePage } from './new-device-page';

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

  it('offers the fingerprint switch only on a kiosk', async () => {
    await signInForTests('admin@samtec.example');
    renderDevicePage(KIOSK_ID);
    await screen.findByRole('heading', { name: /Kiosk/ });

    expect(screen.getByRole('checkbox')).toBeChecked();
    expect(screen.queryByLabelText('Serial number')).not.toBeInTheDocument();
  });
});

describe('NewDevicePage', () => {
  it('registers a terminal and shows its secret once', async () => {
    await signInForTests('admin@samtec.example');
    const user = userEvent.setup();
    const { queryClient, unmount } = renderWithProviders(<NewDevicePage />);

    await user.type(screen.getByLabelText('Name'), 'Ridge Towers back gate');
    await screen.findByRole('option', { name: /Choose a site/ });
    await user.selectOptions(screen.getByLabelText('Site'), '01927c3e-1111-7aaa-8bbb-0c0c0c0c0c01');
    await user.click(screen.getByRole('button', { name: 'Register device' }));

    expect(await screen.findByRole('heading', { name: 'Device registered' })).toBeInTheDocument();
    expect(screen.getByLabelText<HTMLInputElement>('Secret').value.length).toBeGreaterThan(20);

    unmount();
    await waitFor(() => expect(queryClient.getMutationCache().getAll()).toEqual([]));
  });
});
