import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { signInForTests } from '@/test/session';
import { AttendancePage } from './attendance-page';

describe('AttendancePage', () => {
  it('lists the last week of shifts with site, times and counted hours', async () => {
    await signInForTests('admin@samtec.example');

    renderWithProviders(<AttendancePage />);

    // Kwame works day shifts at Ridge Towers most days.
    expect(
      (await screen.findAllByRole('link', { name: 'Kwame Kofi Mensah' })).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText('ACC-01 · Ridge Towers Office Complex').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Counted').length).toBeGreaterThan(0);
    expect(screen.getByText(/shifts on this page/)).toBeInTheDocument();
  });

  it('refuses a range that ends before it starts, without asking the API', async () => {
    await signInForTests('admin@samtec.example');
    const user = userEvent.setup();
    renderWithProviders(<AttendancePage />);
    await screen.findAllByRole('link', { name: 'Kwame Kofi Mensah' });

    const to = screen.getByLabelText('To');
    await user.clear(to);
    await user.type(to, '2020-01-01');
    await user.click(screen.getByRole('button', { name: 'Show days' }));

    expect(
      await screen.findByText('The last day must be on or after the first day.'),
    ).toBeInTheDocument();
    // The table still shows the week that was loaded.
    expect(screen.getAllByRole('link', { name: 'Kwame Kofi Mensah' }).length).toBeGreaterThan(0);
  });

  it('shows a supervisor only their own site', async () => {
    await signInForTests('supervisor@samtec.example');

    renderWithProviders(<AttendancePage />);

    await screen.findAllByRole('link', { name: 'Kwame Kofi Mensah' });
    expect(screen.queryByText('ACC-02 · East Legon Residences')).not.toBeInTheDocument();
  });
});
