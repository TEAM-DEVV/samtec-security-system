import { screen } from '@testing-library/react';
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { env } from '@/lib/env';
import { mockAccounts } from '@/mocks/data/accounts';
import { server } from '@/mocks/node';
import { renderWithProviders } from '@/test/render';
import { signInForTests } from '@/test/session';
import { UsersPage } from './users-page';

describe('UsersPage', () => {
  it('lists every sign-in account with its role and status', async () => {
    await signInForTests('admin@samtec.example');

    renderWithProviders(<UsersPage />);

    expect(await screen.findByRole('link', { name: 'Efua Mensah' })).toBeInTheDocument();
    expect(screen.getByText('supervisor@samtec.example')).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'HR & payroll' })).toBeInTheDocument();
    expect(screen.getAllByRole('cell', { name: 'Active' })).toHaveLength(mockAccounts.length);
    expect(screen.getByRole('link', { name: 'Add account' })).toBeInTheDocument();
  });

  it('shows the API error with a way to try again', async () => {
    await signInForTests('admin@samtec.example');
    server.use(
      http.get(`${env.apiBaseUrl}/users`, () =>
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

    renderWithProviders(<UsersPage />);

    expect(await screen.findByText('Users could not be loaded')).toBeInTheDocument();
    expect(screen.getByText('The database is not available.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
