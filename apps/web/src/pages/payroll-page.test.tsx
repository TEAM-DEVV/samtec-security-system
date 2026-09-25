import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { signInForTests } from '@/test/session';
import { nextMonthToOpen, PayrollPage } from './payroll-page';

describe('PayrollPage', () => {
  it('shows the months and every run, with the money as cedis', async () => {
    await signInForTests('hr@samtec.example');

    renderWithProviders(<PayrollPage />);

    // The seeded month, and the runs worked out for it.
    expect(await screen.findByRole('cell', { name: 'September 2026' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Net pay' })).toBeInTheDocument();
    // Money is never a bare number of pesewas on screen: every amount is cedis
    // with the symbol, through the shared formatter.
    const amounts = screen.getAllByText(/^GH₵ [\d,]+\.\d{2}$/);
    expect(amounts.length).toBeGreaterThan(1);
  });

  it('lets a payroll officer open a month and work out a run', async () => {
    await signInForTests('hr@samtec.example');

    renderWithProviders(<PayrollPage />);
    await screen.findByRole('cell', { name: 'September 2026' });

    // Both actions are offered, because the API accepts them from this role.
    expect(screen.getByRole('button', { name: /^Open / })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Work out a run' }).length).toBeGreaterThan(0);
  });

  it('offers a guard nothing, because payroll is not theirs to open', async () => {
    // The page itself is behind RequireRole; this proves that even if it were
    // reached, no button that cannot work is shown.
    await signInForTests('guard@samtec.example');

    renderWithProviders(<PayrollPage />);

    expect(screen.queryByRole('button', { name: 'Work out a run' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Open / })).not.toBeInTheDocument();
  });

  it('filters the runs by state', async () => {
    await signInForTests('hr@samtec.example');
    const user = userEvent.setup();

    renderWithProviders(<PayrollPage />);
    await screen.findByRole('cell', { name: 'September 2026' });

    await user.selectOptions(screen.getByLabelText('State'), 'REJECTED');
    // The mock has one rejected run; the paid and draft ones wait behind the filter.
    expect(await screen.findByText('Rejected')).toBeInTheDocument();
  });

  it('says plainly when a month has no approved run yet', async () => {
    await signInForTests('hr@samtec.example');
    renderWithProviders(<PayrollPage />);
    await screen.findByRole('cell', { name: 'September 2026' });
    // Better than an empty cell, which reads as a page that failed to load.
    expect(screen.getAllByText(/None yet|Open it/).length).toBeGreaterThan(0);
  });
});

describe('nextMonthToOpen', () => {
  it('offers this month when nothing has been opened yet', () => {
    expect(nextMonthToOpen([], new Date('2026-09-15T00:00:00Z'))).toEqual({
      year: 2026,
      month: 9,
    });
  });

  it('offers the month after the newest one', () => {
    expect(
      nextMonthToOpen([
        { year: 2026, month: 7 },
        { year: 2026, month: 9 },
        { year: 2026, month: 8 },
      ]),
    ).toEqual({ year: 2026, month: 10 });
  });

  it('rolls December into January of the year after', () => {
    expect(nextMonthToOpen([{ year: 2026, month: 12 }])).toEqual({ year: 2027, month: 1 });
  });

  it('never offers a month that already exists, however they were listed', () => {
    // Out of order on purpose: the newest wins, not the last one in the array.
    const existing = [
      { year: 2027, month: 1 },
      { year: 2026, month: 3 },
    ];
    expect(nextMonthToOpen(existing)).toEqual({ year: 2027, month: 2 });
  });
});
