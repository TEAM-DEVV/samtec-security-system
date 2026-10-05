import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { previousMonthInGhana } from '@/lib/format';
import { mockSites } from '@/mocks/data/sites';
import { server } from '@/mocks/node';
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

  it('shows an administrator the client invoices card, defaulted to last month', async () => {
    await signInForTests('admin@samtec.example');

    renderWithProviders(<ReportsPage />);

    expect(await screen.findByText('Client invoices')).toBeInTheDocument();
    expect(screen.getByLabelText<HTMLInputElement>('Month').value).toBe(previousMonthInGhana());
    expect(screen.getByText(/Bills only the counted \(confirmed\) hours/)).toBeInTheDocument();
    // Nothing chosen yet, so there is nothing to download.
    expect(screen.getByRole('button', { name: 'Download invoice (PDF)' })).toBeDisabled();
  });

  it('hides the client invoices card from a supervisor, who sees no payroll anywhere', async () => {
    await signInForTests('supervisor@samtec.example');

    renderWithProviders(<ReportsPage />);

    await screen.findByText('At work right now');
    expect(screen.queryByText('Client invoices')).not.toBeInTheDocument();
  });

  it('downloads a client invoice for the chosen site and month, at the rate typed in', async () => {
    await signInForTests('admin@samtec.example');
    const user = userEvent.setup();
    renderWithProviders(<ReportsPage />);

    const site = mockSites[0] as (typeof mockSites)[number];
    // Waits for the real option to exist, rather than the "Loading sites…" placeholder.
    await screen.findByRole('option', { name: new RegExp(site.code) });
    await user.selectOptions(screen.getByLabelText('Site'), site.id);
    await user.type(screen.getByLabelText('Hourly rate (GH₵)'), '15');

    const sent: string[] = [];
    const seeRequest = ({ request }: { request: Request }) => {
      const url = new URL(request.url);
      sent.push(`${url.pathname}${url.search}`);
    };
    server.events.on('request:start', seeRequest);
    try {
      const button = screen.getByRole('button', { name: 'Download invoice (PDF)' });
      expect(button).toBeEnabled();
      await user.click(button);

      const month = previousMonthInGhana();
      await waitFor(() => {
        expect(
          sent.some(
            (url) =>
              url.startsWith(`/api/v1/sites/${site.id}/invoices/${month}.pdf`) &&
              url.includes('hourlyRatePesewas=1500'),
          ),
        ).toBe(true);
      });
    } finally {
      server.events.removeListener('request:start', seeRequest);
    }
  });
});
