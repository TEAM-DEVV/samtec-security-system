import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { signInForTests } from '@/test/session';
import { NewDevicePage } from './new-device-page';

const SITE_ID = '01927c3e-1111-7aaa-8bbb-0c0c0c0c0c01';

async function registerDevice(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.type(screen.getByLabelText('Name'), name);
  await screen.findByRole('option', { name: /Choose a site/ });
  await user.selectOptions(screen.getByLabelText('Site'), SITE_ID);
  await user.click(screen.getByRole('button', { name: 'Register device' }));
  await screen.findByRole('heading', { name: 'Device registered' });
}

describe('NewDevicePage', () => {
  it('registers a terminal and shows its secret once', async () => {
    await signInForTests('admin@samtec.example');
    const user = userEvent.setup();
    const { queryClient, unmount } = renderWithProviders(<NewDevicePage />);

    await registerDevice(user, 'Ridge Towers back gate');
    expect(screen.getByLabelText<HTMLInputElement>('Secret').value.length).toBeGreaterThan(20);

    unmount();
    await waitFor(() => expect(queryClient.getMutationCache().getAll()).toEqual([]));
  });

  it('explains each kind of device in plain words, and keeps Face kiosk as the default', async () => {
    await signInForTests('admin@samtec.example');
    const user = userEvent.setup();
    renderWithProviders(<NewDevicePage />);

    expect(screen.getByLabelText('Kind')).toHaveValue('FACE_KIOSK');
    expect(screen.getByText(/It does face recognition/)).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Kind'), 'ZKTECO');
    expect(screen.getByText(/wall-mounted fingerprint clock/)).toBeInTheDocument();
    expect(screen.queryByText(/It does face recognition/)).not.toBeInTheDocument();

    // The simulator is for development and TEST, so it is never offered here.
    expect(screen.queryByRole('option', { name: 'Simulator' })).not.toBeInTheDocument();
  });

  it('shows the three set-up steps, with Copy buttons for the ID and the secret', async () => {
    await signInForTests('admin@samtec.example');
    const user = userEvent.setup();
    renderWithProviders(<NewDevicePage />);

    await registerDevice(user, 'Ridge Towers side gate');

    expect(screen.getByText('Register')).toBeInTheDocument();
    expect(screen.getByText('Set up the kiosk')).toBeInTheDocument();
    expect(screen.getByText('Switch it on')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: "this device's page" })).toBeInTheDocument();

    expect(screen.getAllByRole('button', { name: 'Copy' })).toHaveLength(2);
  });
});
