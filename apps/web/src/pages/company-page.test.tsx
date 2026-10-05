import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { MOCK_COMPANY_NAME } from '@/mocks/data/company';
import { MOCK_PASSWORD } from '@/mocks/data/users';
import { renderWithProviders } from '@/test/render';
import { signInForTests } from '@/test/session';
import { CompanyPage } from './company-page';

describe('CompanyPage', () => {
  it("renders the company's name and its bank account, masked", async () => {
    await signInForTests('admin@samtec.example');
    renderWithProviders(<CompanyPage />);

    expect(await screen.findByText(MOCK_COMPANY_NAME)).toBeInTheDocument();
    expect(await screen.findByDisplayValue('Akwaaba Bank')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Ridge')).toBeInTheDocument();
    // The real account number is never shown — only its last four digits.
    expect(screen.getByText(/Currently on file:\s*\*\*\*\* 0123/)).toBeInTheDocument();
    expect(screen.queryByText('1234567890123')).not.toBeInTheDocument();
    // The account number field itself always starts blank.
    expect(screen.getByLabelText('Account number')).toHaveValue('');
    // Explains what the account is for, in one sentence.
    expect(
      screen.getByText(/paid out of this account|drawn from this account/),
    ).toBeInTheDocument();
  });

  it('saves a change through the password dialog', async () => {
    await signInForTests('admin@samtec.example', { confirmPassword: false });
    const user = userEvent.setup();
    renderWithProviders(<CompanyPage />);

    const branch = await screen.findByLabelText('Branch');
    await user.clear(branch);
    await user.type(branch, 'Osu');
    // The account number is never shown back, so keeping it means typing it
    // again — leaving it blank is a separate, deliberate way to remove it,
    // covered by its own test below.
    await user.type(screen.getByLabelText('Account number'), '1234567890123');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    const dialog = await screen.findByRole('alertdialog', { name: 'Confirm with your password' });
    await user.type(within(dialog).getByLabelText('Password'), MOCK_PASSWORD);
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));

    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByLabelText('Branch')).toHaveValue('Osu');
    });
    // One confirmation covers the next change too: no dialog this time.
    expect(
      screen.queryByRole('alertdialog', { name: 'Confirm with your password' }),
    ).not.toBeInTheDocument();
  });

  it('will not silently clear the account number: leaving it blank needs a second step', async () => {
    await signInForTests('admin@samtec.example');
    const user = userEvent.setup();
    renderWithProviders(<CompanyPage />);

    // Change only the bank name; the account number field is left blank, as
    // it always starts.
    const bankName = await screen.findByLabelText('Bank name');
    await user.clear(bankName);
    await user.type(bankName, 'Ghana Commercial Bank');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText(/would remove/)).toBeInTheDocument();
    // Nothing was sent: the bank name on screen is still only what was typed, unsaved.
    expect(screen.queryByText('Saved.')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove the account number' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(screen.getByText(/Currently on file:\s*no account number/)).toBeInTheDocument();
  });

  it('lets a payroll officer read the details, but offers them nothing to change', async () => {
    await signInForTests('hr@samtec.example');
    renderWithProviders(<CompanyPage />);

    expect(await screen.findByText('Akwaaba Bank')).toBeInTheDocument();
    expect(screen.getByText('Ridge')).toBeInTheDocument();
    expect(screen.getByText('**** 0123')).toBeInTheDocument();
    expect(screen.queryByText('1234567890123')).not.toBeInTheDocument();
    expect(screen.getByText('Only an administrator can change these details.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save changes' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Account number')).not.toBeInTheDocument();
  });

  it('shows a clear error rather than a blank form when loading fails', async () => {
    await signInForTests('guard@samtec.example');
    renderWithProviders(<CompanyPage />);

    // A guard has no business here; the API refuses, and the page says so
    // rather than showing a blank form.
    expect(await screen.findByText(/could not be loaded/)).toBeInTheDocument();
  });
});
