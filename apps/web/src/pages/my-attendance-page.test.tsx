import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { signInForTests } from '@/test/session';
import { MyAttendancePage } from './my-attendance-page';

describe('MyAttendancePage', () => {
  it('shows a guard their own shifts, without an employee column', async () => {
    await signInForTests('guard@samtec.example');

    renderWithProviders(<MyAttendancePage />);

    expect(await screen.findByText(/shifts on this page/)).toBeInTheDocument();
    expect(screen.getAllByText('ACC-01 · Ridge Towers Office Complex').length).toBeGreaterThan(0);
    expect(screen.queryByRole('columnheader', { name: 'Employee' })).not.toBeInTheDocument();
    expect(screen.queryByText('Akua Asante')).not.toBeInTheDocument();
  });

  it('explains to an administrator that their account has no employee record', async () => {
    await signInForTests('admin@samtec.example');

    renderWithProviders(<MyAttendancePage />);

    expect(
      await screen.findByText('No employee record is linked to your account'),
    ).toBeInTheDocument();
  });
});
