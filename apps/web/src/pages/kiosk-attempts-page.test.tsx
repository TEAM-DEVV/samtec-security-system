import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { routes } from '@/app/routes';
import { renderWithProviders } from '@/test/render';
import { signInForTests } from '@/test/session';
import { KioskAttemptsPage } from './kiosk-attempts-page';

/** The ACC-01 kiosk in src/mocks/data/devices.ts. */
const KIOSK_ID = '01927c3e-4444-7ddd-8eee-000000000006';

// The outcome filter lists every label too, so the checks below look at table cells.
describe('KioskAttemptsPage', () => {
  it('shows an administrator the failures, the "Not me" and the co-sign', async () => {
    await signInForTests('admin@samtec.example');

    renderWithProviders(<KioskAttemptsPage />);

    // The supervisor's co-sign names the worker it was for.
    expect(await screen.findByText(/co-signed for Kwame Kofi Mensah/)).toBeInTheDocument();
    expect(screen.getByText('Supervisor co-sign')).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Cancelled with "Not me"' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Face did not look live' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Not recognised' })).toBeInTheDocument();
    expect(screen.getAllByText('Nobody matched').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('cell', { name: 'Matched' }).length).toBeGreaterThan(0);
  });

  it('filters by outcome', async () => {
    await signInForTests('admin@samtec.example');
    const user = userEvent.setup();
    renderWithProviders(<KioskAttemptsPage />);
    await screen.findByText(/co-signed for Kwame Kofi Mensah/);

    await user.selectOptions(screen.getByLabelText('Outcome'), 'LOW_LIVENESS');

    expect(await screen.findByRole('cell', { name: 'Face did not look live' })).toBeInTheDocument();
    expect(screen.queryByRole('cell', { name: 'Matched' })).not.toBeInTheDocument();
  });

  it('starts on the kiosk named in the address', async () => {
    await signInForTests('admin@samtec.example');

    renderWithProviders(<KioskAttemptsPage />, { route: routes.kioskAttempts(KIOSK_ID) });

    // The kiosk list arrives a moment after the page; the choice then shows.
    const kiosk = await screen.findByLabelText<HTMLSelectElement>('Kiosk');
    await waitFor(() => expect(kiosk.value).toBe(KIOSK_ID));
    expect(await screen.findByText(/co-signed for Kwame Kofi Mensah/)).toBeInTheDocument();
  });

  it('ignores an address that names something other than an ID', async () => {
    await signInForTests('admin@samtec.example');

    renderWithProviders(<KioskAttemptsPage />, {
      route: `${routes.kioskAttempts()}?deviceId=<script>`,
    });

    expect(await screen.findByText(/co-signed for Kwame Kofi Mensah/)).toBeInTheDocument();
    expect(screen.getByLabelText<HTMLSelectElement>('Kiosk').value).toBe('');
    expect(screen.queryByText('Attempts could not be loaded')).not.toBeInTheDocument();
  });
});
