import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { routes } from '@/app/routes';
import { mockDevices } from '@/mocks/data/devices';
import { MOCK_PASSWORD } from '@/mocks/data/users';
import { DeviceDetailPage } from '@/pages/device-detail-page';
import { renderWithProviders } from '@/test/render';
import { signInForTests } from '@/test/session';

const KIOSK_ID = mockDevices.find((device) => device.kind === 'FACE_KIOSK')?.id ?? '';

/**
 * The one "Confirm with your password" dialog, through a real page: switching
 * a device off is a sensitive action, so the first click opens the dialog and
 * the action goes ahead once the password is right.
 */
function renderKioskPage() {
  return renderWithProviders(
    <Routes>
      <Route path="/devices/:deviceId" element={<DeviceDetailPage />} />
    </Routes>,
    { route: routes.device(KIOSK_ID) },
  );
}

async function switchOff(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Switch off' }));
  const confirmSwitch = await screen.findByRole('alertdialog', { name: /Switch off/ });
  await user.click(within(confirmSwitch).getByRole('button', { name: 'Switch off' }));
}

describe('PasswordConfirmationDialog', () => {
  it('asks for the password before a sensitive action, refuses a wrong one, then goes ahead', async () => {
    await signInForTests('admin@samtec.example', { confirmPassword: false });
    const user = userEvent.setup();
    renderKioskPage();
    await switchOff(user);

    const dialog = await screen.findByRole('alertdialog', { name: 'Confirm with your password' });
    expect(
      within(dialog).getByText(/You will not be asked again for five minutes/),
    ).toBeInTheDocument();

    await user.type(within(dialog).getByLabelText('Password'), 'not-the-password');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(await within(dialog).findByText('Your password is incorrect.')).toBeInTheDocument();

    await user.clear(within(dialog).getByLabelText('Password'));
    await user.type(within(dialog).getByLabelText('Password'), MOCK_PASSWORD);
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));

    // The action was sent again by itself: the device is now switched off.
    expect(await screen.findByRole('button', { name: 'Switch on' })).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.queryByRole('alertdialog', { name: 'Confirm with your password' }),
      ).not.toBeInTheDocument();
    });

    // One confirmation covers the next sensitive action: no dialog this time.
    await user.click(screen.getByRole('button', { name: 'Switch on' }));
    expect(await screen.findByRole('button', { name: 'Switch off' })).toBeInTheDocument();
    expect(
      screen.queryByRole('alertdialog', { name: 'Confirm with your password' }),
    ).not.toBeInTheDocument();
  });

  it('leaves the action refused, and says so, when the person cancels', async () => {
    await signInForTests('admin@samtec.example', { confirmPassword: false });
    const user = userEvent.setup();
    renderKioskPage();
    await switchOff(user);

    const dialog = await screen.findByRole('alertdialog', { name: 'Confirm with your password' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    // Said beside the button and in the error panel, like every refused action.
    expect(await screen.findAllByText('Confirm with your password to continue.')).not.toHaveLength(
      0,
    );
    // Nothing changed: the device is still switched on.
    expect(screen.getByRole('button', { name: 'Switch off' })).toBeInTheDocument();
  });

  it('never appears once the password was confirmed at sign-in', async () => {
    await signInForTests('admin@samtec.example');
    const user = userEvent.setup();
    renderKioskPage();
    await switchOff(user);

    expect(await screen.findByRole('button', { name: 'Switch on' })).toBeInTheDocument();
    expect(
      screen.queryByRole('alertdialog', { name: 'Confirm with your password' }),
    ).not.toBeInTheDocument();
  });
});
