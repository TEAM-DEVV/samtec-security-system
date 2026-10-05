import { screen } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { env } from '@/lib/env';
import { server } from '@/mocks/node';
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

  it('shows the API error with a way to try again', async () => {
    await signInForTests('guard@samtec.example');
    server.use(
      http.get(`${env.apiBaseUrl}/attendance/segments`, () =>
        HttpResponse.json(
          {
            type: 'about:blank',
            title: 'Internal Server Error',
            status: 500,
            detail: 'The database is not available.',
            traceId: 'trace-test-500',
          },
          { status: 500 },
        ),
      ),
    );

    renderWithProviders(<MyAttendancePage />);

    expect(await screen.findByText('Your shifts could not be loaded')).toBeInTheDocument();
    expect(screen.getByText('The database is not available.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
