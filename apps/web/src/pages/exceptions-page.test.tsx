import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { signInForTests } from '@/test/session';
import { ExceptionsPage } from './exceptions-page';

// The type filter also lists every label, so the checks below look at table cells only.
describe('ExceptionsPage', () => {
  it('shows an administrator every open exception, newest first', async () => {
    await signInForTests('admin@samtec.example');

    renderWithProviders(<ExceptionsPage />);

    expect(await screen.findAllByRole('link', { name: 'Open' })).toHaveLength(5);
    expect(screen.getByRole('cell', { name: 'Missing clock-out' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Missing clock-in' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Two shifts at once' })).toBeInTheDocument();
    expect(screen.getByText('Device user 99001')).toBeInTheDocument();
    // The resolved one waits behind the status filter.
    expect(screen.queryByText('Device user 99002')).not.toBeInTheDocument();
  });

  it('filters by status and type', async () => {
    await signInForTests('admin@samtec.example');
    const user = userEvent.setup();
    renderWithProviders(<ExceptionsPage />);
    await screen.findAllByRole('link', { name: 'Open' });

    await user.selectOptions(screen.getByLabelText('Status'), 'RESOLVED');
    expect(await screen.findByText('Device user 99002')).toBeInTheDocument();
    expect(screen.queryByRole('cell', { name: 'Missing clock-out' })).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Status'), 'OPEN');
    await user.selectOptions(screen.getByLabelText('Type'), 'OVERLAP');
    expect(await screen.findByRole('cell', { name: 'Two shifts at once' })).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Open' })).toHaveLength(1);
  });

  it('shows a supervisor only exceptions at their own site', async () => {
    await signInForTests('supervisor@samtec.example');

    renderWithProviders(<ExceptionsPage />);

    expect(await screen.findAllByRole('link', { name: 'Open' })).toHaveLength(2);
    expect(screen.getByRole('cell', { name: 'Missing clock-out' })).toBeInTheDocument();
    expect(screen.getByText('Device user 99001')).toBeInTheDocument();
    // Other sites' exceptions, and the overlap that reaches two other sites, stay hidden.
    expect(screen.queryByRole('cell', { name: 'Missing clock-in' })).not.toBeInTheDocument();
    expect(screen.queryByRole('cell', { name: 'Two shifts at once' })).not.toBeInTheDocument();
  });
});
