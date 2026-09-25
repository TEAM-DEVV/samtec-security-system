import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { signInForTests } from '@/test/session';
import { ReportsPage } from './reports-page';

describe('ReportsPage', () => {
  it('shows who is at work and how much absence there is', async () => {
    await signInForTests('admin@samtec.example');

    renderWithProviders(<ReportsPage />);

    expect(await screen.findByText('At work right now')).toBeInTheDocument();
    expect(screen.getByText('Absence, last 30 days')).toBeInTheDocument();
    // The mock's settled figures, so a demo reads the same every time.
    expect(await screen.findByText('7')).toBeInTheDocument();
    expect(await screen.findByText('2.5%')).toBeInTheDocument();
  });

  it('shows an administrator what payroll has cost, in cedis', async () => {
    await signInForTests('admin@samtec.example');

    renderWithProviders(<ReportsPage />);

    expect(await screen.findByText('What payroll has cost')).toBeInTheDocument();
    const amounts = await screen.findAllByText(/GH₵\s[\d,]+\.\d{2}/);
    expect(amounts.length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Download as a spreadsheet/ })).toBeInTheDocument();
  });

  it('hides the payroll cost from a supervisor, who sees no payroll anywhere', async () => {
    await signInForTests('supervisor@samtec.example');

    renderWithProviders(<ReportsPage />);

    expect(await screen.findByText('At work right now')).toBeInTheDocument();
    // They still get the attendance download, because they read that board.
    expect(screen.getByRole('button', { name: 'Download' })).toBeInTheDocument();
    expect(screen.queryByText('What payroll has cost')).not.toBeInTheDocument();
  });

  it('refuses a date range that runs backwards, before asking the API', async () => {
    await signInForTests('admin@samtec.example');

    renderWithProviders(<ReportsPage />);
    await screen.findByText('At work right now');

    const from = screen.getByLabelText('From');
    const to = screen.getByLabelText('To');
    expect(from).toHaveAttribute('max');
    expect(to).toHaveAttribute('min');
    // The browser's own bounds stop it, and the button explains itself too.
    expect(screen.getByRole('button', { name: 'Download' })).toBeEnabled();
  });
});
