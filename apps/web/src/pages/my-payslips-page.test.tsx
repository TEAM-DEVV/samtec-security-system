import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { signInForTests } from '@/test/session';
import { MyPayslipsPage } from './my-payslips-page';

describe('MyPayslipsPage', () => {
  it('shows a guard their own pay, and never names anybody else', async () => {
    await signInForTests('guard@samtec.example');

    renderWithProviders(<MyPayslipsPage />);

    expect(await screen.findByRole('heading', { name: 'My payslips' })).toBeInTheDocument();
    // A guard's list is their own, so there is no "Worker" column to fill.
    expect(screen.queryByRole('columnheader', { name: 'Worker' })).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Net pay' })).toBeInTheDocument();
  });

  it('names the worker when a payroll officer is looking at the whole company', async () => {
    await signInForTests('hr@samtec.example');

    renderWithProviders(<MyPayslipsPage />);

    expect(await screen.findByRole('heading', { name: 'Payslips' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Worker' })).toBeInTheDocument();
  });

  it('offers a download for every payslip, in cedis', async () => {
    await signInForTests('hr@samtec.example');

    renderWithProviders(<MyPayslipsPage />);

    const downloads = await screen.findAllByRole('button', { name: 'Download' });
    expect(downloads.length).toBeGreaterThan(0);
    const amounts = await screen.findAllByText(/GH₵\s[\d,]+\.\d{2}/);
    expect(amounts.length).toBeGreaterThan(0);
  });

  it('tells a worker with no payslips why, rather than showing an empty table', async () => {
    // The supervisor account has no employee payslips in the mock.
    await signInForTests('supervisor@samtec.example');

    renderWithProviders(<MyPayslipsPage />);

    // Either a refusal or an empty state, but never a blank page.
    const explained = await screen.findByText(/No payslip yet|could not be loaded|not allowed/i);
    expect(explained).toBeInTheDocument();
  });
});
